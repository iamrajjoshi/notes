import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DELIBERATE_CRASH_EXIT_CODE,
  DurableHarnessStore,
  resumeRun,
} from "../notes/05-harness-engineering/examples/durable-harness.mjs";

const harnessPath = fileURLToPath(
  new URL("../notes/05-harness-engineering/examples/durable-harness.mjs", import.meta.url),
);

function scenario(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `durable-harness-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    dbPath: join(directory, "harness.sqlite"),
    runId: `run-${name}`,
    tenantId: `shop-${name}`,
    operationId: `incident-${name}:maintenance-on`,
  };
}

function startCli(args) {
  const child = spawn(process.execPath, [harnessPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function runCli(args) {
  return startCli(args).completion;
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function initialize(input, nowMs = 1_000) {
  const store = new DurableHarnessStore(input.dbPath);
  try {
    store.initializeRun({ ...input, nowMs });
  } finally {
    store.close();
  }
}

test("the stable operation record deduplicates a repeated business effect", (t) => {
  const input = scenario(t, "dedupe");
  const store = new DurableHarnessStore(input.dbPath);
  try {
    store.initializeRun({ ...input, nowMs: 1_000 });
    const lease = store.acquireLease({
      runId: input.runId,
      workerId: "writer",
      leaseMs: 1_000,
      nowMs: 1_100,
    });
    const first = store.applyBusinessEffect({
      runId: input.runId,
      workerId: "writer",
      leaseEpoch: lease.epoch,
      nowMs: 1_200,
    });
    const replay = store.applyBusinessEffect({
      runId: input.runId,
      workerId: "writer",
      leaseEpoch: lease.epoch,
      nowMs: 1_300,
    });

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(store.getService(input.tenantId).effectCount, 1);
    assert.equal(store.getOperation(input.operationId).result.effectSequence, 1);
    const overlapping = store.acquireLease({
      runId: input.runId,
      workerId: "writer",
      leaseMs: 1_000,
      nowMs: 1_400,
    });
    assert.equal(
      overlapping.status,
      "conflict",
      "a worker label cannot renew or inherit an active lease",
    );
    assert.equal(overlapping.current.epoch, lease.epoch);
    const reacquired = store.acquireLease({
      runId: input.runId,
      workerId: "writer",
      leaseMs: 1_000,
      nowMs: 2_100,
    });
    assert.equal(
      reacquired.epoch,
      lease.epoch + 1,
      "an expired same-name worker gets a new fencing epoch",
    );
  } finally {
    store.close();
  }
});

test("a paused resume worker rechecks the clock and rejects its expired lease", async (t) => {
  const input = scenario(t, "expiry");
  const readyFile = join(input.directory, "worker-ready");
  const releaseFile = join(input.directory, "release-worker");
  const seed = new DurableHarnessStore(input.dbPath);
  try {
    seed.initializeRun({ ...input, nowMs: 1_000 });
    const firstLease = seed.acquireLease({
      runId: input.runId,
      workerId: "writer",
      leaseMs: 100,
      nowMs: 1_000,
    });
    const secondLease = seed.acquireLease({
      runId: input.runId,
      workerId: "writer",
      leaseMs: 100,
      nowMs: 1_100,
    });
    assert.equal(secondLease.epoch, firstLease.epoch + 1);
    seed.applyBusinessEffect({
      runId: input.runId,
      workerId: "writer",
      leaseEpoch: secondLease.epoch,
      nowMs: 1_150,
    });
  } finally {
    seed.close();
  }

  let nowMs = 1_300;
  const resume = resumeRun({
    dbPath: input.dbPath,
    runId: input.runId,
    workerId: "paused-worker",
    leaseMs: 100,
    clock: () => nowMs,
    readyFile,
    releaseFile,
  });
  await waitForPath(readyFile);
  nowMs = 1_500;
  writeFileSync(releaseFile, "continue");
  assert.deepEqual(await resume, {
    status: "conflict",
    reason: "stale_lease",
    currentLease: {
      runId: input.runId,
      workerId: "paused-worker",
      epoch: 3,
      acquiredAtMs: 1_300,
      expiresAtMs: 1_400,
    },
  });
  const store = new DurableHarnessStore(input.dbPath);
  try {
    assert.ok(
      store
        .listReceipts(input.runId)
        .some(
          ({ kind, status, details }) =>
            kind === "checkpoint" && status === "conflict" && details.reason === "stale_lease",
        ),
    );
  } finally {
    store.close();
  }
});

test("a fresh process reconciles a committed effect after the writer dies before checkpoint", async (t) => {
  const input = scenario(t, "crash");
  initialize(input);

  const crashed = await runCli([
    "crash-after-effect",
    "--db",
    input.dbPath,
    "--run-id",
    input.runId,
    "--worker-id",
    "writer",
    "--now-ms",
    "1100",
    "--lease-ms",
    "100",
  ]);
  assert.equal(crashed.code, DELIBERATE_CRASH_EXIT_CODE, crashed.stderr);

  let store = new DurableHarnessStore(input.dbPath);
  try {
    assert.equal(store.getService(input.tenantId).maintenance, true);
    assert.equal(store.getService(input.tenantId).effectCount, 1);
    assert.equal(store.getOperation(input.operationId).result.operationId, input.operationId);
    assert.equal(store.getRun(input.runId).phase, "effect_pending");
    assert.equal(store.getRun(input.runId).version, 0);
  } finally {
    store.close();
  }

  const resumed = await runCli([
    "resume",
    "--db",
    input.dbPath,
    "--run-id",
    input.runId,
    "--worker-id",
    "recovery-worker",
    "--acquire-now-ms",
    "1300",
    "--reconcile-now-ms",
    "1300",
    "--lease-ms",
    "1000",
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "advanced");

  store = new DurableHarnessStore(input.dbPath);
  try {
    assert.equal(store.getRun(input.runId).phase, "effect_reconciled");
    assert.equal(store.getRun(input.runId).version, 1);
    assert.equal(store.getService(input.tenantId).effectCount, 1);
    assert.equal(
      store
        .listReceipts(input.runId)
        .filter(({ kind, status }) => kind === "effect" && status === "committed").length,
      1,
    );
    assert.equal(
      store
        .listReceipts(input.runId)
        .filter(({ kind, status }) => kind === "reconciliation" && status === "advanced").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("two resume processes race, and the stale lease epoch records a conflict", async (t) => {
  const input = scenario(t, "race");
  const readyFile = join(input.directory, "old-worker-ready");
  const releaseFile = join(input.directory, "release-old-worker");
  const seed = new DurableHarnessStore(input.dbPath);
  try {
    seed.initializeRun({ ...input, nowMs: 1_000 });
    const lease = seed.acquireLease({
      runId: input.runId,
      workerId: "effect-worker",
      leaseMs: 100,
      nowMs: 1_100,
    });
    seed.applyBusinessEffect({
      runId: input.runId,
      workerId: "effect-worker",
      leaseEpoch: lease.epoch,
      nowMs: 1_150,
    });
  } finally {
    seed.close();
  }

  const oldWorker = startCli([
    "resume",
    "--db",
    input.dbPath,
    "--run-id",
    input.runId,
    "--worker-id",
    "old-worker",
    "--acquire-now-ms",
    "1300",
    "--reconcile-now-ms",
    "1600",
    "--lease-ms",
    "100",
    "--ready-file",
    readyFile,
    "--release-file",
    releaseFile,
  ]);
  t.after(() => {
    if (oldWorker.child.exitCode === null) oldWorker.child.kill("SIGKILL");
  });

  await waitForPath(readyFile);
  let currentResult;
  try {
    currentResult = await runCli([
      "resume",
      "--db",
      input.dbPath,
      "--run-id",
      input.runId,
      "--worker-id",
      "current-worker",
      "--acquire-now-ms",
      "1500",
      "--reconcile-now-ms",
      "1500",
      "--lease-ms",
      "1000",
    ]);
  } finally {
    writeFileSync(releaseFile, "continue");
  }
  const staleResult = await oldWorker.completion;

  assert.equal(currentResult.code, 0, currentResult.stderr);
  assert.equal(staleResult.code, 0, staleResult.stderr);
  assert.equal(JSON.parse(currentResult.stdout).status, "advanced");
  assert.deepEqual(
    {
      status: JSON.parse(staleResult.stdout).status,
      reason: JSON.parse(staleResult.stdout).reason,
    },
    { status: "conflict", reason: "stale_lease" },
  );

  const store = new DurableHarnessStore(input.dbPath);
  try {
    assert.equal(store.getRun(input.runId).version, 1);
    assert.equal(store.getLease(input.runId).workerId, "current-worker");
    assert.equal(store.getLease(input.runId).epoch, 3);
    assert.equal(store.getService(input.tenantId).effectCount, 1);
    assert.equal(
      store
        .listReceipts(input.runId)
        .filter(({ kind, status }) => kind === "reconciliation" && status === "advanced").length,
      1,
    );
    assert.ok(
      store
        .listReceipts(input.runId)
        .some(
          ({ kind, status, details }) =>
            kind === "checkpoint" && status === "conflict" && details.reason === "stale_lease",
        ),
    );
  } finally {
    store.close();
  }
});
