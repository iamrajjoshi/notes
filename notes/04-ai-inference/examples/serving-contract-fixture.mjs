import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/*
 * A dependency-free serving-contract fixture for Node 22 or newer.
 *
 * It is not a model, tokenizer, inference engine, or performance benchmark.
 * Fixed text and delays make HTTP, SSE streaming, cancellation, queueing, and
 * metrics visible before you repeat the same checks against a real engine.
 */

export const FIXTURE_MODEL = "deterministic-serving-fixture-v1";
const defaults = { host: "127.0.0.1", port: 0, maxActive: 2, maxQueued: 16, chunkDelayMs: 12 };
const round = (value) => Number(value.toFixed(3));

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function normalizeInput(value) {
  if (typeof value !== "string") throw new TypeError("input must be a string");
  const input = value.trim().replace(/\s+/g, " ");
  if (!input || input.length > 1_000)
    throw new TypeError("input must contain 1 to 1,000 characters");
  return input;
}

function chunksOf(value, size = 7) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size)
    chunks.push(value.slice(index, index + size));
  return chunks;
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new RangeError("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function eventStream(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function newState() {
  return {
    sequence: 0,
    total: 0,
    completed: 0,
    cancelled: 0,
    rejected: 0,
    failed: 0,
    active: 0,
    queued: 0,
    maxActive: 0,
    maxQueued: 0,
    outputChunks: 0,
    latencyCount: 0,
    latencySumMs: 0,
    firstChunkCount: 0,
    firstChunkSumMs: 0,
  };
}

function terminal(state, startedAt) {
  state.latencyCount += 1;
  state.latencySumMs += performance.now() - startedAt;
}

function metricsText(state) {
  const samples = {
    fixture_requests_total: ["counter", state.total],
    fixture_requests_completed_total: ["counter", state.completed],
    fixture_requests_cancelled_total: ["counter", state.cancelled],
    fixture_requests_rejected_total: ["counter", state.rejected],
    fixture_requests_failed_total: ["counter", state.failed],
    fixture_requests_active: ["gauge", state.active],
    fixture_requests_queued: ["gauge", state.queued],
    fixture_max_active_observed: ["gauge", state.maxActive],
    fixture_max_queued_observed: ["gauge", state.maxQueued],
    fixture_output_chunks_total: ["counter", state.outputChunks],
    fixture_request_latency_seconds_count: ["counter", state.latencyCount],
    fixture_request_latency_seconds_sum: ["counter", state.latencySumMs / 1_000],
    fixture_time_to_first_chunk_seconds_count: ["counter", state.firstChunkCount],
    fixture_time_to_first_chunk_seconds_sum: ["counter", state.firstChunkSumMs / 1_000],
  };
  return `${Object.entries(samples)
    .flatMap(([name, [type, value]]) => [`# TYPE ${name} ${type}`, `${name} ${value}`])
    .join("\n")}\n`;
}

function abortError() {
  const error = new Error("client cancelled the request");
  error.name = "AbortError";
  return error;
}

async function acquireSlot(state, config, signal) {
  if (state.active >= config.maxActive) {
    if (state.queued >= config.maxQueued) {
      const error = new Error("fixture queue is full");
      error.name = "QueueFullError";
      throw error;
    }
    state.queued += 1;
    state.maxQueued = Math.max(state.maxQueued, state.queued);
    try {
      while (state.active >= config.maxActive) await delay(2, undefined, { signal });
    } finally {
      state.queued -= 1;
    }
  }
  if (signal.aborted) throw abortError();
  state.active += 1;
  state.maxActive = Math.max(state.maxActive, state.active);
  let released = false;
  return () => {
    if (!released) state.active -= 1;
    released = true;
  };
}

async function serveInference({
  input,
  stream,
  requestId,
  response,
  signal,
  state,
  config,
  startedAt,
}) {
  const outputText = `fixture:${input}`;
  const outputChunks = chunksOf(outputText);
  if (stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
  }

  for (let index = 0; index < outputChunks.length; index += 1) {
    await delay(config.chunkDelayMs, undefined, { signal });
    if (signal.aborted || response.destroyed) throw abortError();
    state.outputChunks += 1;
    if (stream) {
      if (index === 0) {
        state.firstChunkCount += 1;
        state.firstChunkSumMs += performance.now() - startedAt;
      }
      response.write(
        eventStream("response.output_text.delta", {
          requestId,
          index,
          delta: outputChunks[index],
        }),
      );
    }
  }

  const usage = { inputCharacters: input.length, outputCharacters: outputText.length };
  state.completed += 1;
  terminal(state, startedAt);
  if (stream) {
    response.end(eventStream("response.completed", { requestId, outputText, usage }));
  } else {
    sendJson(response, 200, {
      id: requestId,
      object: "fixture.response",
      model: FIXTURE_MODEL,
      outputText,
      usage,
    });
  }
}

export async function startFixtureServer(options = {}) {
  const config = { ...defaults, ...options };
  for (const [name, value] of Object.entries({
    port: config.port,
    maxActive: config.maxActive,
    maxQueued: config.maxQueued,
    chunkDelayMs: config.chunkDelayMs,
  })) {
    if (!Number.isInteger(value) || value < (name === "maxQueued" || name === "port" ? 0 : 1)) {
      throw new TypeError(`${name} has an invalid value`);
    }
  }
  const state = newState();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${config.host}`).pathname;
    if (request.method === "GET" && pathname === "/fixture-info") {
      sendJson(response, 200, {
        name: FIXTURE_MODEL,
        purpose: "deterministic serving contract; not model inference or a benchmark",
        config: {
          maxActive: config.maxActive,
          maxQueued: config.maxQueued,
          chunkDelayMs: config.chunkDelayMs,
        },
      });
      return;
    }
    if (request.method === "GET" && pathname === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(metricsText(state));
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/responses") {
      sendJson(response, 404, { error: "route not found" });
      return;
    }

    let input;
    let stream;
    try {
      const body = await readJson(request);
      input = normalizeInput(body.input);
      if (body.stream !== undefined && typeof body.stream !== "boolean")
        throw new TypeError("stream must be boolean");
      stream = body.stream === true;
    } catch (error) {
      sendJson(response, error instanceof RangeError ? 413 : 400, { error: error.message });
      return;
    }

    state.sequence += 1;
    state.total += 1;
    const requestId = `fixture-${String(state.sequence).padStart(6, "0")}`;
    const startedAt = performance.now();
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onClose);
    let release;
    try {
      release = await acquireSlot(state, config, controller.signal);
      await serveInference({
        input,
        stream,
        requestId,
        response,
        signal: controller.signal,
        state,
        config,
        startedAt,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        state.cancelled += 1;
        terminal(state, startedAt);
      } else if (error.name === "QueueFullError") {
        state.rejected += 1;
        if (!response.headersSent) sendJson(response, 429, { error: error.message });
      } else {
        state.failed += 1;
        terminal(state, startedAt);
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else if (!response.destroyed) response.destroy(error);
      }
    } finally {
      response.off("close", onClose);
      release?.();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const baseUrl = `http://${config.host}:${address.port}`;
  return {
    baseUrl,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const endpoint = (baseUrl, path) => `${baseUrl.replace(/\/$/, "")}${path}`;

export async function makeNormalRequest(baseUrl, input) {
  const response = await fetch(endpoint(baseUrl, "/v1/responses"), {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ input, stream: false }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function parseEvent(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length ? { event, data: JSON.parse(data.join("\n")) } : undefined;
}

export async function makeStreamingRequest(baseUrl, input, { cancelAfterChunks } = {}) {
  const controller = new AbortController();
  const response = await fetch(endpoint(baseUrl, "/v1/responses"), {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ input, stream: true }),
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let outputText = "";
  let outputChunks = 0;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseEvent(frame);
      if (!event) continue;
      events.push(event);
      if (event.event === "response.output_text.delta") {
        outputChunks += 1;
        outputText += event.data.delta;
        if (cancelAfterChunks && outputChunks >= cancelAfterChunks) {
          await reader.cancel("controlled cancellation");
          controller.abort();
          return { cancelled: true, outputChunks, outputText, events };
        }
      }
    }
    if (done) break;
  }
  return {
    cancelled: false,
    outputChunks,
    outputText,
    terminal: events.find(({ event }) => event === "response.completed")?.data,
    events,
  };
}

export function parsePrometheus(text) {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+(?:\.\d+)?)$/);
      return match ? [[match[1], Number(match[2])]] : [];
    }),
  );
}

export async function fetchFixtureMetrics(baseUrl) {
  const response = await fetch(endpoint(baseUrl, "/metrics"), { headers: { connection: "close" } });
  const text = await response.text();
  return { text, values: parsePrometheus(text) };
}

async function waitForCancellation(baseUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const metrics = await fetchFixtureMetrics(baseUrl);
    if (metrics.values.fixture_requests_cancelled_total >= 1) return;
    await delay(5);
  }
  throw new Error("server did not observe cancellation");
}

export async function runControlledLoad(
  baseUrl,
  { totalRequests = 8, clientConcurrency = 4 } = {},
) {
  let next = 0;
  let completed = 0;
  let failed = 0;
  const latencies = [];
  const startedAt = performance.now();
  async function worker() {
    while (next < totalRequests) {
      const index = next;
      next += 1;
      const requestStartedAt = performance.now();
      try {
        await makeNormalRequest(baseUrl, `load-${String(index).padStart(3, "0")}`);
        completed += 1;
      } catch {
        failed += 1;
      }
      latencies.push(performance.now() - requestStartedAt);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(totalRequests, clientConcurrency) }, () => worker()),
  );
  return {
    requested: totalRequests,
    clientConcurrency,
    completed,
    failed,
    elapsedMs: round(performance.now() - startedAt),
    clientLatencyMs: {
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      max: round(Math.max(...latencies)),
    },
  };
}

export async function runFixtureExercise(
  baseUrl,
  { totalRequests = 8, clientConcurrency = 4 } = {},
) {
  const info = await (
    await fetch(endpoint(baseUrl, "/fixture-info"), { headers: { connection: "close" } })
  ).json();
  const normal = await makeNormalRequest(baseUrl, "normal request");
  const stream = await makeStreamingRequest(baseUrl, "stream request");
  const cancellation = await makeStreamingRequest(baseUrl, "cancel after the first chunk", {
    cancelAfterChunks: 1,
  });
  await waitForCancellation(baseUrl);
  const load = await runControlledLoad(baseUrl, { totalRequests, clientConcurrency });
  const { values: metrics } = await fetchFixtureMetrics(baseUrl);
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    fixture: {
      ...info,
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      externalDependencies: [],
      requiresModel: false,
      requiresGpu: false,
      requiresExternalNetwork: false,
    },
    evidence: {
      normal: {
        id: normal.id,
        model: normal.model,
        outputText: normal.outputText,
        usage: normal.usage,
      },
      stream: {
        outputChunks: stream.outputChunks,
        outputText: stream.outputText,
        terminalEvent: stream.terminal,
      },
      cancellation: {
        requestedAfterChunks: 1,
        clientObservedChunks: cancellation.outputChunks,
        clientCancelled: cancellation.cancelled,
        serverCancelledTotal: metrics.fixture_requests_cancelled_total,
      },
      load,
      metrics: {
        requestsTotal: metrics.fixture_requests_total,
        completedTotal: metrics.fixture_requests_completed_total,
        cancelledTotal: metrics.fixture_requests_cancelled_total,
        rejectedTotal: metrics.fixture_requests_rejected_total,
        active: metrics.fixture_requests_active,
        queued: metrics.fixture_requests_queued,
        maxActiveObserved: metrics.fixture_max_active_observed,
        maxQueuedObserved: metrics.fixture_max_queued_observed,
        requestLatencyObservationCount: metrics.fixture_request_latency_seconds_count,
        timeToFirstChunkObservationCount: metrics.fixture_time_to_first_chunk_seconds_count,
      },
    },
    interpretation: [
      "Outputs and event order are deterministic; measured timings depend on the local machine and are observations, not promises.",
      "Characters and fixed delays stand in for tokenization and model execution; do not compare this record with GPU throughput.",
      "Repeat the same request, stream, cancellation, load, and metrics checks against a pinned engine and model bundle.",
    ],
  };
}

function integer(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1) throw new TypeError("invalid integer option");
  return result;
}

async function main(args) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      requests: { type: "string" },
      concurrency: { type: "string" },
    },
  });
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== "demo")) {
    throw new Error("usage: serving-contract-fixture.mjs [demo] [--requests N] [--concurrency N]");
  }
  const fixture = await startFixtureServer();
  try {
    const record = await runFixtureExercise(fixture.baseUrl, {
      totalRequests: integer(values.requests, 8),
      clientConcurrency: integer(values.concurrency, 4),
    });
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
