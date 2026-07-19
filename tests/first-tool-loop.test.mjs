import assert from "node:assert/strict";
import test from "node:test";

import {
  readService,
  runFirstToolLoop,
} from "../notes/05-harness-engineering/examples/first-tool-loop.mjs";

test("the first loop crosses the five model-host-tool boundaries in order", async () => {
  const executions = [];
  const result = await runFirstToolLoop({
    executeRead(arguments_) {
      executions.push(arguments_);
      return readService(arguments_);
    },
  });

  assert.deepEqual(
    result.trace.map(({ stage }) => stage),
    [
      "model_proposal",
      "host_validation",
      "tool_execution",
      "observation_returned",
      "model_terminal_answer",
    ],
  );
  assert.deepEqual(executions, [{ service: "checkout" }]);
  assert.deepEqual(
    result.messages.map(({ role }) => role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(result.messages[2].content[0].data, {
    service: "checkout",
    status: "healthy",
    region: "us-west-2",
  });
  assert.equal(result.answer, "checkout is healthy in us-west-2.");
});

test("the host rejects malformed arguments before the tool executes", async () => {
  let executed = false;
  const model = {
    async respond() {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-invalid",
            name: "read_service",
            arguments: { service: 42 },
          },
        ],
      };
    },
  };

  await assert.rejects(
    runFirstToolLoop({
      model,
      executeRead() {
        executed = true;
      },
    }),
    /requires exactly one non-empty string field/,
  );
  assert.equal(executed, false);
});
