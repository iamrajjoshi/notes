import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonMemoryStore,
  InvalidArgumentsModel,
  LoopingModel,
  ScriptedModel,
  demoTask,
  runEvalSuite,
  runHarness,
} from "../notes/05-harness-engineering/examples/minimal-harness.mjs";

const taskCopy = () => JSON.parse(JSON.stringify(demoTask));

test("the public harness completes one model-tool-result-terminal loop", async () => {
  const task = taskCopy();
  const result = await runHarness({ task, model: new ScriptedModel(task) });

  assert.equal(result.state.status, "accepted");
  assert.equal(result.state.terminal.stopReason, "end_turn");
  assert.deepEqual(
    result.state.messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
  );
  assert.ok(Object.values(result.state.verification.checks).every(Boolean));
});

test("policy blocks retrieved instructions from widening authority", async () => {
  const task = taskCopy();
  const result = await runHarness({ task, model: new ScriptedModel(task) });
  const denial = result.state.receipts.find((receipt) => receipt.toolCallId === "call-bad");

  assert.equal(denial.status, "denied");
  assert.match(denial.reason, /only the task tenant/);
  assert.equal(result.store.services["shop-99"].maintenance, false);
});

test("an uncertain write reconciles through its stable operation ID", async () => {
  const task = taskCopy();
  const result = await runHarness({ task, model: new ScriptedModel(task) });
  const receipt = result.state.receipts.find((candidate) => candidate.toolCallId === "call-write");

  assert.equal(receipt.initialOutcome, "unknown");
  assert.equal(receipt.status, "succeeded_after_reconciliation");
  assert.equal(receipt.reconciliation.status, "confirmed_applied");
  assert.equal(Object.keys(result.store.committedOperations).length, 1);
  assert.equal(result.store.committedOperations[task.operationId].result.maintenance, true);
});

test("checkpoints remain JSON serializable and detached from callers", async () => {
  const task = taskCopy();
  const store = new JsonMemoryStore();
  const result = await runHarness({ task, model: new ScriptedModel(task), store });
  const serialized = JSON.stringify(result.store);
  const checkpoint = store.loadCheckpoint("run-demo");

  assert.equal(JSON.parse(serialized).checkpoints["run-demo"].status, "accepted");
  checkpoint.status = "tampered";
  assert.equal(store.loadCheckpoint("run-demo").status, "accepted");
});

test("a fresh model adapter can resume from a JSON checkpoint", async () => {
  const task = taskCopy();
  const store = new JsonMemoryStore();
  const firstAttempt = await runHarness({
    task,
    model: new ScriptedModel(task),
    store,
    runId: "run-resume",
    maxSteps: 1,
  });
  assert.equal(firstAttempt.state.stopReason, "max_steps");

  const resumed = await runHarness({
    task,
    model: new ScriptedModel(task),
    store,
    runId: "run-resume",
    maxSteps: 6,
  });
  assert.equal(resumed.state.status, "accepted");
  assert.equal(resumed.state.step, 4);
  assert.equal(resumed.state.messages.filter((message) => message.role === "tool").length, 3);
});

test("schema validation rejects a malformed provider call before execution", async () => {
  const task = taskCopy();
  const result = await runHarness({
    task,
    model: new InvalidArgumentsModel(),
    runId: "run-invalid-test",
  });
  const receipt = result.state.receipts[0];

  assert.equal(receipt.toolCallId, "call-invalid");
  assert.equal(receipt.status, "rejected");
  assert.match(receipt.reason, /arguments\.tenantId must be a string/);
  assert.deepEqual(result.store.committedOperations, {});
});

test("the host stops a model that consumes its entire step budget", async () => {
  const task = taskCopy();
  const result = await runHarness({
    task,
    model: new LoopingModel(task.tenantId),
    runId: "run-loop-test",
    maxSteps: 2,
  });

  assert.equal(result.state.status, "stopped");
  assert.equal(result.state.stopReason, "max_steps");
  assert.equal(result.state.step, 2);
  assert.equal(result.state.receipts.length, 2);
});

test("the bundled eval cases all pass", async () => {
  const evaluations = await runEvalSuite();
  assert.equal(evaluations.length, 5);
  assert.deepEqual(
    evaluations.filter((evaluation) => !evaluation.passed),
    [],
  );
});
