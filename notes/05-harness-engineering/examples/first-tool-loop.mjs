import { pathToFileURL } from "node:url";

/*
 * The smallest useful agent loop: one model proposal, one read-only tool, and
 * one terminal answer. Later examples add policy, streaming, writes, durable
 * state, and verification; none of those mechanisms are hidden here.
 */

const services = Object.freeze({
  checkout: Object.freeze({ status: "healthy", region: "us-west-2" }),
});

export const demoRequest = "What is the current status of the checkout service?";

export function validateReadServiceArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("read_service arguments must be an object");
  }
  if (
    Object.keys(value).length !== 1 ||
    typeof value.service !== "string" ||
    value.service.length === 0
  ) {
    throw new Error("read_service requires exactly one non-empty string field: service");
  }
  return { service: value.service };
}

export function readService({ service }) {
  const record = services[service];
  if (!record) throw new Error(`unknown service ${service}`);
  return { service, ...record };
}

export class ScriptedReadModel {
  async respond(messages) {
    const lastMessage = messages.at(-1);
    if (lastMessage.role !== "tool") {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-read-checkout",
            name: "read_service",
            arguments: { service: "checkout" },
          },
        ],
      };
    }

    const observation = lastMessage.content[0].data;
    return {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${observation.service} is ${observation.status} in ${observation.region}.`,
        },
      ],
    };
  }
}

export async function runFirstToolLoop({
  model = new ScriptedReadModel(),
  executeRead = readService,
  request = demoRequest,
} = {}) {
  const messages = [{ role: "user", content: [{ type: "text", text: request }] }];
  const trace = [];

  const proposal = await model.respond(messages);
  const call = proposal?.content?.[0];
  if (
    proposal?.role !== "assistant" ||
    proposal?.content?.length !== 1 ||
    call?.type !== "tool_call"
  ) {
    throw new Error("the first model response must propose one tool call");
  }
  messages.push(proposal);
  trace.push({
    stage: "model_proposal",
    toolCallId: call.id,
    tool: call.name,
    arguments: call.arguments,
  });

  if (call.name !== "read_service") throw new Error(`unknown tool ${call.name}`);
  const arguments_ = validateReadServiceArguments(call.arguments);
  trace.push({ stage: "host_validation", accepted: true, arguments: arguments_ });

  const result = await executeRead(arguments_);
  trace.push({ stage: "tool_execution", tool: call.name, result });

  const observation = {
    role: "tool",
    toolCallId: call.id,
    content: [{ type: "tool_result", data: result }],
  };
  messages.push(observation);
  trace.push({ stage: "observation_returned", toolCallId: call.id, observation: result });

  const terminal = await model.respond(messages);
  const text = terminal?.content?.[0];
  if (terminal?.role !== "assistant" || terminal?.content?.length !== 1 || text?.type !== "text") {
    throw new Error("the second model response must be a terminal text answer");
  }
  messages.push(terminal);
  trace.push({ stage: "model_terminal_answer", text: text.text });

  return { answer: text.text, messages, trace };
}

async function main() {
  const result = await runFirstToolLoop();
  process.stdout.write(
    `${JSON.stringify({ answer: result.answer, trace: result.trace }, null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
