import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fetchFixtureMetrics,
  makeNormalRequest,
  makeStreamingRequest,
  runFixtureExercise,
  startFixtureServer,
} from "../notes/04-ai-inference/examples/serving-contract-fixture.mjs";

const fixturePath = fileURLToPath(
  new URL("../notes/04-ai-inference/examples/serving-contract-fixture.mjs", import.meta.url),
);

async function waitForCancellation(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const metrics = await fetchFixtureMetrics(baseUrl);
    if (metrics.values.fixture_requests_cancelled_total === 1) return metrics;
    await delay(10);
  }
  throw new Error("fixture did not record the controlled cancellation");
}

test("the local fixture serves normal, streamed, cancelled, and observable requests", async (t) => {
  const fixture = await startFixtureServer({ chunkDelayMs: 4, maxActive: 2 });
  t.after(() => fixture.close());

  const normal = await makeNormalRequest(fixture.baseUrl, "normal request");
  assert.equal(normal.model, "deterministic-serving-fixture-v1");
  assert.equal(normal.outputText, "fixture:normal request");
  assert.deepEqual(normal.usage, { inputCharacters: 14, outputCharacters: 22 });

  const stream = await makeStreamingRequest(fixture.baseUrl, "stream request");
  assert.equal(stream.cancelled, false);
  assert.equal(stream.outputText, "fixture:stream request");
  assert.ok(stream.outputChunks > 1);
  assert.deepEqual(
    stream.events.map(({ event }) => event),
    [
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ],
  );

  const cancelled = await makeStreamingRequest(fixture.baseUrl, "cancel after one chunk", {
    cancelAfterChunks: 1,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.outputChunks, 1);

  const metrics = await waitForCancellation(fixture.baseUrl);
  assert.equal(metrics.values.fixture_requests_total, 3);
  assert.equal(metrics.values.fixture_requests_completed_total, 2);
  assert.equal(metrics.values.fixture_requests_cancelled_total, 1);
  assert.equal(metrics.values.fixture_requests_active, 0);
  assert.equal(metrics.values.fixture_requests_queued, 0);
  assert.match(metrics.text, /# TYPE fixture_requests_active gauge/);
});

test("controlled load prints a baseline that preserves limits and caveats", async (t) => {
  const fixture = await startFixtureServer({ chunkDelayMs: 5, maxActive: 2, maxQueued: 8 });
  t.after(() => fixture.close());

  const record = await runFixtureExercise(fixture.baseUrl, {
    totalRequests: 6,
    clientConcurrency: 4,
  });

  assert.equal(record.fixture.requiresModel, false);
  assert.equal(record.fixture.requiresGpu, false);
  assert.equal(record.fixture.requiresExternalNetwork, false);
  assert.deepEqual(record.fixture.externalDependencies, []);
  assert.equal(record.evidence.normal.outputText, "fixture:normal request");
  assert.equal(record.evidence.stream.outputText, "fixture:stream request");
  assert.equal(record.evidence.cancellation.clientCancelled, true);
  assert.equal(record.evidence.load.completed, 6);
  assert.equal(record.evidence.load.failed, 0);
  assert.equal(record.evidence.metrics.requestsTotal, 9);
  assert.equal(record.evidence.metrics.completedTotal, 8);
  assert.equal(record.evidence.metrics.cancelledTotal, 1);
  assert.equal(record.evidence.metrics.maxActiveObserved, 2);
  assert.ok(record.evidence.metrics.maxQueuedObserved >= 1);
  assert.equal(record.evidence.metrics.active, 0);
  assert.equal(record.evidence.metrics.queued, 0);
  assert.match(record.interpretation.join(" "), /not promises/);
  assert.match(record.interpretation.join(" "), /do not compare.*GPU throughput/);
});

test("the one-command demo emits a machine-readable baseline record", async () => {
  const child = spawn(
    process.execPath,
    [fixturePath, "demo", "--requests", "4", "--concurrency", "3"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const record = JSON.parse(stdout);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.evidence.load.requested, 4);
  assert.equal(record.evidence.metrics.requestsTotal, 7);
  assert.equal(record.evidence.metrics.cancelledTotal, 1);
});
