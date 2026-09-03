#!/usr/bin/env node
// Live probes for the /v1/responses facade against a running proxy.
// Needs real tokens, so it is not part of `npm test`.
//
//   node scripts/live_responses.js
//   BASE=http://127.0.0.1:13000 API_KEY=devkey node scripts/live_responses.js

const BASE = process.env.BASE || "http://127.0.0.1:13000";
const API_KEY = process.env.API_KEY || "devkey";
const MODEL = process.env.MODEL || "claude-4.5-haiku";

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failed++;
  // Detail is whatever the caller had at hand — an object, undefined, a status
  // code. Stringifying defensively keeps a failed assertion from crashing the
  // run and hiding every check after it.
  let text = "";
  if (detail !== undefined && detail !== null) {
    text = typeof detail === "string" ? detail : JSON.stringify(detail);
    if (text === undefined) text = String(detail);
    text = ` — ${String(text).slice(0, 300)}`;
  }
  console.log(`  FAIL ${name}${text}`);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function streamEvents(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = [];
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return { status: res.status, events, raw };
}

async function main() {
  console.log(`probing ${BASE} with model=${MODEL}\n`);

  console.log("non-streaming");
  {
    const { status, json } = await post("/v1/responses", {
      model: MODEL,
      input: "Reply with exactly: pong",
    });
    check("status 200", status === 200, `got ${status}`);
    check("object=response", json && json.object === "response", JSON.stringify(json).slice(0, 200));
    check("status=completed", json && json.status === "completed", json && json.status);
    check("has a message item", json && (json.output || []).some((i) => i.type === "message"));
    check("output_text is filled", json && typeof json.output_text === "string" && json.output_text.length > 0, json && JSON.stringify(json.output_text));
    check("usage renamed to input_tokens", json && json.usage && typeof json.usage.input_tokens === "number");
    check("store reported false", json && json.store === false);
    if (json && json.output_text) console.log(`       model said: ${JSON.stringify(json.output_text.slice(0, 80))}`);
  }

  console.log("\ninstructions + max_output_tokens");
  {
    const { status, json } = await post("/v1/responses", {
      model: MODEL,
      instructions: "You always answer in exactly one word.",
      input: "Name a colour.",
      max_output_tokens: 20,
    });
    check("status 200", status === 200, `got ${status}`);
    check("answered", json && json.output_text && json.output_text.length > 0);
    check("echoes instructions", json && typeof json.instructions === "string");
    if (json && json.output_text) console.log(`       model said: ${JSON.stringify(json.output_text.slice(0, 80))}`);
  }

  console.log("\nstreaming");
  {
    const { status, events } = await streamEvents("/v1/responses", {
      model: MODEL,
      input: "List the numbers one, two and three, separated by commas. Nothing else.",
      stream: true,
    });
    const types = events.map((e) => e.type);
    check("status 200", status === 200, `got ${status}`);
    check("opens with response.created", types[0] === "response.created", types[0]);
    check("has in_progress", types.includes("response.in_progress"));
    check("has output_item.added", types.includes("response.output_item.added"));
    check("has text deltas", types.filter((t) => t === "response.output_text.delta").length > 0);
    check("closes the item", types.includes("response.output_item.done"));
    check("ends with response.completed", types[types.length - 1] === "response.completed", types[types.length - 1]);
    check(
      "sequence numbers are monotonic from 0",
      events.every((e, i) => e.sequence_number === i)
    );
    const done = events.find((e) => e.type === "response.completed");
    check("final carries usage", Boolean(done && done.response && done.response.usage.input_tokens >= 0));
    const text = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    check("deltas reassemble into the final text", Boolean(done && done.response.output_text === text));
    console.log(`       streamed: ${JSON.stringify(text.slice(0, 80))}`);
  }

  console.log("\ntools");
  {
    const { status, json } = await post("/v1/responses", {
      model: MODEL,
      input: "What is the weather in Paris? Use the tool.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });
    check("status 200", status === 200, json && json.error ? json.error : `got ${status}`);
    const call = json && (json.output || []).find((i) => i.type === "function_call");
    check("returned a function_call item", Boolean(call), (json && (json.output || json.error)) || `status ${status}`);
    if (call) {
      check("call has call_id", Boolean(call.call_id));
      check("call names the tool", call.name === "get_weather", call.name);
      console.log(`       call: ${call.name}(${call.arguments})`);

      console.log("\ntool result round-trip");
      const second = await post("/v1/responses", {
        model: MODEL,
        input: [
          { type: "message", role: "user", content: "What is the weather in Paris? Use the tool." },
          { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
          { type: "function_call_output", call_id: call.call_id, output: '{"temp_c": 18, "sky": "clear"}' },
        ],
      });
      check("status 200", second.status === 200, `got ${second.status}`);
      check("model used the result", Boolean(second.json && second.json.output_text));
      if (second.json && second.json.output_text) {
        console.log(`       model said: ${JSON.stringify(second.json.output_text.slice(0, 120))}`);
      }
    }
  }

  console.log("\nrejections");
  {
    const bg = await post("/v1/responses", { model: MODEL, input: "hi", background: true });
    check("background is 501", bg.status === 501, `got ${bg.status}`);
    const hosted = await post("/v1/responses", { model: MODEL, input: "hi", tools: [{ type: "web_search" }] });
    check("hosted tools are 501", hosted.status === 501, `got ${hosted.status}`);
    const empty = await post("/v1/responses", { model: MODEL, input: "" });
    check("empty input is 400", empty.status === 400, `got ${empty.status}`);
    const get = await fetch(`${BASE}/v1/responses/resp_x`, { headers });
    check("retrieval is 501", get.status === 501, `got ${get.status}`);
  }

  console.log("\nlegacy /v1/completions streaming");
  {
    const { status, events } = await streamEvents("/v1/completions", {
      model: MODEL,
      prompt: "Reply with exactly: pong",
      stream: true,
    });
    check("status 200", status === 200, `got ${status}`);
    check("frames are text_completion", events.length > 0 && events.every((e) => e.object === "text_completion"), events[0] && events[0].object);
    check("ids use the cmpl- prefix", events.length > 0 && String(events[0].id).startsWith("cmpl-"), events[0] && events[0].id);
    const text = events.map((e) => (e.choices && e.choices[0] ? e.choices[0].text || "" : "")).join("");
    check("text arrives in choices[].text", text.length > 0, JSON.stringify(text));
    console.log(`       streamed: ${JSON.stringify(text.slice(0, 80))}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
