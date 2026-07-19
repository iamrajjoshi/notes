import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/*
 * A dependency-free durability example for Node 26.
 *
 * SQLite is the authoritative service and workflow store in this small demo,
 * so the service mutation and its idempotency record can share a transaction.
 * A real remote effect needs the remote system's idempotency/reconciliation
 * contract instead of a cross-system transaction.
 */

export const DELIBERATE_CRASH_EXIT_CODE = 86;

const encode = (value) => JSON.stringify(value);
const decode = (value) => JSON.parse(value);
const digest = (value) => createHash("sha256").update(encode(value)).digest("hex");
const asBoolean = (value) => Boolean(Number(value));

export class DurableHarnessStore {
  constructor(dbPath) {
    if (!dbPath || dbPath === ":memory:")
      throw new Error("supply a file-backed SQLite database path");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        tenant_id TEXT PRIMARY KEY,
        maintenance INTEGER NOT NULL CHECK (maintenance IN (0, 1)),
        effect_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES services(tenant_id),
        input_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES services(tenant_id),
        operation_id TEXT NOT NULL,
        target_enabled INTEGER NOT NULL CHECK (target_enabled IN (0, 1)),
        phase TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES run_checkpoints(run_id),
        operation_id TEXT,
        worker_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leases (
        run_id TEXT PRIMARY KEY REFERENCES run_checkpoints(run_id),
        worker_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS receipts_by_run ON receipts(run_id, receipt_id);
    `);
  }

  close() {
    this.db.close();
  }

  #transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  #insertReceipt({
    runId,
    operationId = null,
    workerId,
    leaseEpoch,
    kind,
    status,
    details = {},
    nowMs,
  }) {
    this.db
      .prepare(`
      INSERT INTO receipts (
        run_id, operation_id, worker_id, lease_epoch, kind, status, details_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(runId, operationId, workerId, leaseEpoch, kind, status, encode(details), nowMs);
  }

  initializeRun({ runId, tenantId, operationId, targetEnabled = true, nowMs = Date.now() }) {
    return this.#transaction(() => {
      this.db
        .prepare(`
        INSERT INTO services (tenant_id, maintenance, effect_count) VALUES (?, 0, 0)
      `)
        .run(tenantId);
      const checkpoint = {
        phase: "effect_pending",
        operationId,
        nextSafeAction: "apply the operation once, or reconcile it if the outcome is unknown",
      };
      this.db
        .prepare(`
        INSERT INTO run_checkpoints (
          run_id, tenant_id, operation_id, target_enabled, phase, checkpoint_json, version, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'effect_pending', ?, 0, ?)
      `)
        .run(runId, tenantId, operationId, Number(targetEnabled), encode(checkpoint), nowMs);
      return this.getRun(runId);
    });
  }

  getRun(runId) {
    const row = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ?").get(runId);
    if (!row) return undefined;
    return {
      runId: row.run_id,
      tenantId: row.tenant_id,
      operationId: row.operation_id,
      targetEnabled: asBoolean(row.target_enabled),
      phase: row.phase,
      checkpoint: decode(row.checkpoint_json),
      version: Number(row.version),
    };
  }

  getService(tenantId) {
    const row = this.db.prepare("SELECT * FROM services WHERE tenant_id = ?").get(tenantId);
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      maintenance: asBoolean(row.maintenance),
      effectCount: Number(row.effect_count),
    };
  }

  getOperation(operationId) {
    const row = this.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId);
    if (!row) return undefined;
    return {
      operationId: row.operation_id,
      tenantId: row.tenant_id,
      inputDigest: row.input_digest,
      result: decode(row.result_json),
      committedAtMs: Number(row.committed_at_ms),
    };
  }

  getLease(runId) {
    const row = this.db.prepare("SELECT * FROM leases WHERE run_id = ?").get(runId);
    if (!row) return undefined;
    return {
      runId: row.run_id,
      workerId: row.worker_id,
      epoch: Number(row.epoch),
      acquiredAtMs: Number(row.acquired_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  listReceipts(runId) {
    return this.db
      .prepare("SELECT * FROM receipts WHERE run_id = ? ORDER BY receipt_id")
      .all(runId)
      .map((row) => ({
        receiptId: Number(row.receipt_id),
        runId: row.run_id,
        operationId: row.operation_id,
        workerId: row.worker_id,
        leaseEpoch: Number(row.lease_epoch),
        kind: row.kind,
        status: row.status,
        details: decode(row.details_json),
        createdAtMs: Number(row.created_at_ms),
      }));
  }

  acquireLease({ runId, workerId, leaseMs = 5_000, nowMs = Date.now() }) {
    if (!(leaseMs > 0)) throw new Error("leaseMs must be positive");
    return this.#transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      const current = this.getLease(runId);

      if (current && current.expiresAtMs > nowMs) {
        this.#insertReceipt({
          runId,
          workerId,
          leaseEpoch: current.epoch,
          kind: "lease",
          status: "conflict",
          details: { reason: "lease_held", currentWorkerId: current.workerId },
          nowMs,
        });
        return { status: "conflict", reason: "lease_held", current };
      }

      const epoch = (current?.epoch ?? 0) + 1;
      this.db
        .prepare(`
        INSERT INTO leases (run_id, worker_id, epoch, acquired_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          epoch = excluded.epoch,
          acquired_at_ms = excluded.acquired_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `)
        .run(runId, workerId, epoch, nowMs, nowMs + leaseMs);
      this.#insertReceipt({
        runId,
        workerId,
        leaseEpoch: epoch,
        kind: "lease",
        status: "acquired",
        details: { expiresAtMs: nowMs + leaseMs },
        nowMs,
      });
      return { status: "acquired", workerId, epoch, expectedVersion: run.version };
    });
  }

  applyBusinessEffect({ runId, workerId, leaseEpoch, nowMs = Date.now() }) {
    return this.#transaction(() => {
      const run = this.getRun(runId);
      const lease = this.getLease(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      if (
        !lease ||
        lease.workerId !== workerId ||
        lease.epoch !== leaseEpoch ||
        lease.expiresAtMs <= nowMs
      ) {
        throw new Error("only the current unexpired lease may apply the effect");
      }

      const input = { tenantId: run.tenantId, enabled: run.targetEnabled };
      const inputDigest = digest(input);
      const prior = this.getOperation(run.operationId);
      if (prior) {
        if (prior.inputDigest !== inputDigest)
          throw new Error("operation ID was reused with different input");
        this.#insertReceipt({
          runId,
          operationId: run.operationId,
          workerId,
          leaseEpoch,
          kind: "effect",
          status: "replayed",
          details: prior.result,
          nowMs,
        });
        return { status: "committed", replayed: true, result: prior.result };
      }

      const update = this.db
        .prepare(`
        UPDATE services
        SET maintenance = ?, effect_count = effect_count + 1
        WHERE tenant_id = ?
      `)
        .run(Number(run.targetEnabled), run.tenantId);
      if (Number(update.changes) !== 1) throw new Error(`unknown tenant ${run.tenantId}`);
      const service = this.getService(run.tenantId);
      const result = {
        operationId: run.operationId,
        tenantId: run.tenantId,
        maintenance: service.maintenance,
        effectSequence: service.effectCount,
      };
      this.db
        .prepare(`
        INSERT INTO operations (operation_id, tenant_id, input_digest, result_json, committed_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `)
        .run(run.operationId, run.tenantId, inputDigest, encode(result), nowMs);
      this.#insertReceipt({
        runId,
        operationId: run.operationId,
        workerId,
        leaseEpoch,
        kind: "effect",
        status: "committed",
        details: result,
        nowMs,
      });
      return { status: "committed", replayed: false, result };
    });
  }

  reconcileAndAdvance({ runId, workerId, leaseEpoch, expectedVersion, nowMs = Date.now() }) {
    return this.#transaction(() => {
      const run = this.getRun(runId);
      const lease = this.getLease(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      if (
        !lease ||
        lease.workerId !== workerId ||
        lease.epoch !== leaseEpoch ||
        lease.expiresAtMs <= nowMs
      ) {
        this.#insertReceipt({
          runId,
          operationId: run.operationId,
          workerId,
          leaseEpoch,
          kind: "checkpoint",
          status: "conflict",
          details: { reason: "stale_lease", currentLease: lease ?? null },
          nowMs,
        });
        return { status: "conflict", reason: "stale_lease", currentLease: lease };
      }
      if (run.version !== expectedVersion) {
        this.#insertReceipt({
          runId,
          operationId: run.operationId,
          workerId,
          leaseEpoch,
          kind: "checkpoint",
          status: "conflict",
          details: { reason: "version_changed", expectedVersion, actualVersion: run.version },
          nowMs,
        });
        return { status: "conflict", reason: "version_changed", actualVersion: run.version };
      }
      if (run.phase === "effect_reconciled") {
        return { status: "already_complete", version: run.version, checkpoint: run.checkpoint };
      }

      const operation = this.getOperation(run.operationId);
      const expectedDigest = digest({ tenantId: run.tenantId, enabled: run.targetEnabled });
      if (!operation || operation.inputDigest !== expectedDigest) {
        this.#insertReceipt({
          runId,
          operationId: run.operationId,
          workerId,
          leaseEpoch,
          kind: "reconciliation",
          status: operation ? "conflict" : "missing",
          details: { reason: operation ? "operation_input_changed" : "operation_not_found" },
          nowMs,
        });
        return {
          status: "uncertain",
          reason: operation ? "operation_input_changed" : "operation_not_found",
        };
      }

      const checkpoint = {
        phase: "effect_reconciled",
        operationId: run.operationId,
        result: operation.result,
        owner: { workerId, leaseEpoch },
        nextSafeAction: "verify the terminal claim",
      };
      const update = this.db
        .prepare(`
        UPDATE run_checkpoints
        SET phase = 'effect_reconciled', checkpoint_json = ?, version = version + 1, updated_at_ms = ?
        WHERE run_id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM leases
            WHERE leases.run_id = run_checkpoints.run_id
              AND leases.worker_id = ? AND leases.epoch = ? AND leases.expires_at_ms > ?
          )
      `)
        .run(encode(checkpoint), nowMs, runId, expectedVersion, workerId, leaseEpoch, nowMs);
      if (Number(update.changes) !== 1) {
        this.#insertReceipt({
          runId,
          operationId: run.operationId,
          workerId,
          leaseEpoch,
          kind: "checkpoint",
          status: "conflict",
          details: { reason: "compare_and_set_failed", expectedVersion },
          nowMs,
        });
        return { status: "conflict", reason: "compare_and_set_failed" };
      }
      this.#insertReceipt({
        runId,
        operationId: run.operationId,
        workerId,
        leaseEpoch,
        kind: "reconciliation",
        status: "advanced",
        details: { fromVersion: expectedVersion, toVersion: expectedVersion + 1 },
        nowMs,
      });
      return { status: "advanced", version: expectedVersion + 1, checkpoint };
    });
  }
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function resumeRun({
  dbPath,
  runId,
  workerId,
  leaseMs = 5_000,
  clock = Date.now,
  acquireNowMs,
  readyFile,
  releaseFile,
}) {
  const store = new DurableHarnessStore(dbPath);
  try {
    const run = store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.phase === "effect_reconciled") {
      return { status: "already_complete", version: run.version, checkpoint: run.checkpoint };
    }
    const lease = store.acquireLease({ runId, workerId, leaseMs, nowMs: acquireNowMs ?? clock() });
    if (lease.status === "conflict") return lease;
    if (readyFile) writeFileSync(readyFile, encode({ workerId, epoch: lease.epoch }));
    if (releaseFile) await waitForFile(releaseFile);
    return store.reconcileAndAdvance({
      runId,
      workerId,
      leaseEpoch: lease.epoch,
      expectedVersion: lease.expectedVersion,
      nowMs: clock(),
    });
  } finally {
    store.close();
  }
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      "run-id": { type: "string" },
      "worker-id": { type: "string" },
      "tenant-id": { type: "string" },
      "operation-id": { type: "string" },
      "lease-ms": { type: "string" },
      "now-ms": { type: "string" },
      "acquire-now-ms": { type: "string" },
      "reconcile-now-ms": { type: "string" },
      "ready-file": { type: "string" },
      "release-file": { type: "string" },
    },
  });
  const command = positionals[0];
  const dbPath = required(values, "db");
  const runId = required(values, "run-id");
  const nowMs = values["now-ms"] ? Number(values["now-ms"]) : Date.now();
  const leaseMs = values["lease-ms"] ? Number(values["lease-ms"]) : 5_000;

  if (command === "init") {
    const store = new DurableHarnessStore(dbPath);
    try {
      const run = store.initializeRun({
        runId,
        tenantId: required(values, "tenant-id"),
        operationId: required(values, "operation-id"),
        nowMs,
      });
      process.stdout.write(`${encode(run)}\n`);
    } finally {
      store.close();
    }
    return;
  }

  const workerId = required(values, "worker-id");
  if (command === "crash-after-effect") {
    const store = new DurableHarnessStore(dbPath);
    const lease = store.acquireLease({ runId, workerId, leaseMs, nowMs });
    if (lease.status !== "acquired") throw new Error(`could not acquire lease: ${lease.reason}`);
    store.applyBusinessEffect({ runId, workerId, leaseEpoch: lease.epoch, nowMs });
    store.close();
    process.exit(DELIBERATE_CRASH_EXIT_CODE);
  }
  if (command === "resume") {
    const reconcileNowMs = values["reconcile-now-ms"]
      ? Number(values["reconcile-now-ms"])
      : undefined;
    const result = await resumeRun({
      dbPath,
      runId,
      workerId,
      leaseMs,
      acquireNowMs: values["acquire-now-ms"] ? Number(values["acquire-now-ms"]) : undefined,
      clock: reconcileNowMs === undefined ? Date.now : () => reconcileNowMs,
      readyFile: values["ready-file"],
      releaseFile: values["release-file"],
    });
    process.stdout.write(`${encode(result)}\n`);
    return;
  }
  throw new Error("command must be init, crash-after-effect, or resume");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
