#!/usr/bin/env node
/**
 * Live OpenAI-compat matrix against a running cursor-sand2api.
 * Default: http://127.0.0.1:13000  API_KEY from env.
 */
const BASE = process.env.SAND2API_URL || "http://127.0.0.1:13000";
const KEY = process.env.API_KEY || "devkey";
const MODEL = process.env.MODEL || "kimi-k3-max";

function headers() {
  return {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
}

async function req(method, path, body, { timeout = 120000, stream = false } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
  } finally {
    clearTimeout(t);
  }
}

function parseSse(raw) {
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let finish = null;
  const ids = new Set();
  for (const line of raw.split(/\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      continue;
    }
    if (obj.id) ids.add(obj.id);
    const ch = obj.choices && obj.choices[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) toolCalls.push(...d.tool_calls);
  }
  return { content, reasoning, toolCalls, finish, ids: [...ids] };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

async function main() {
  const health = await req("GET", "/health");
  record("health", health.status === 200 && health.json && health.json.version, JSON.stringify(health.json && { version: health.json.version, tools: health.json.tools }));

  const models = await req("GET", "/v1/models");
  record("GET /v1/models", models.status === 200 && Array.isArray(models.json && models.json.data) && models.json.data.length > 0, `n=${(models.json && models.json.data || []).length}`);

  const one = await req("GET", "/v1/models/" + MODEL);
  record("GET /v1/models/:id", one.status === 200 && one.json && one.json.id === MODEL, one.json && one.json.id);

  const emb = await req("POST", "/v1/embeddings", { model: MODEL, input: "hi" });
  record("embeddings 501", emb.status === 501, String(emb.status));

  const ping = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  const pingContent = ping.json && ping.json.choices && ping.json.choices[0] && ping.json.choices[0].message && ping.json.choices[0].message.content;
  record("non-stream content", ping.status === 200 && typeof pingContent === "string" && pingContent.toLowerCase().includes("pong"), `content=${JSON.stringify(pingContent || "").slice(0, 80)}`);

  const sys = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a test bot. Always answer with the single word: kiwi" },
      { role: "user", content: "hello" },
    ],
  });
  const sysC = sys.json && sys.json.choices && sys.json.choices[0] && sys.json.choices[0].message && sys.json.choices[0].message.content;
  record(
    "system role still returns 正文",
    sys.status === 200 && typeof sysC === "string" && sysC.trim().length > 0,
    `content=${JSON.stringify(sysC || "").slice(0, 80)} (Cursor agent prompt may override system text)`
  );

  const streamRaw = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  const sse = parseSse(streamRaw.text);
  record(
    "stream content (not thinking-only)",
    streamRaw.status === 200 && sse.content.toLowerCase().includes("pong") && sse.ids.length === 1,
    `content=${JSON.stringify(sse.content).slice(0, 60)} reasoning_len=${sse.reasoning.length} finish=${sse.finish} ids=${sse.ids.length}`
  );

  const tools = [
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
    {
      type: "function",
      function: {
        name: "scrape_web",
        description: "Fetch a URL",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    },
  ];

  const helloTools = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    stream: true,
    tools,
    messages: [{ role: "user", content: "Do not call any tool. Reply with exactly: pong" }],
  });
  const helloSse = parseSse(helloTools.text);
  const helloHasBody = helloSse.content.toLowerCase().includes("pong") || (helloSse.finish === "stop" && helloSse.content.length > 0);
  record(
    "stream+tools still returns 正文",
    helloTools.status === 200 && helloHasBody,
    `content=${JSON.stringify(helloSse.content).slice(0, 80)} reasoning_len=${helloSse.reasoning.length} finish=${helloSse.finish} tool_calls=${helloSse.toolCalls.length}`
  );

  const noBuiltin = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Use the Shell or ReadFile built-in tool to list the current directory. If you cannot, reply with exactly: no-builtin" }],
  });
  const nb = noBuiltin.json && noBuiltin.json.choices && noBuiltin.json.choices[0];
  const nbName = nb && nb.message && nb.message.tool_calls && nb.message.tool_calls[0] && nb.message.tool_calls[0].function && nb.message.tool_calls[0].function.name;
  record(
    "no client tools => no built-in tool_calls",
    noBuiltin.status === 200 && (!nb || nb.finish_reason !== "tool_calls") && !["shell", "read_file", "list_dir", "grep"].includes(nbName),
    `finish=${nb && nb.finish_reason} tool=${nbName || "-"} content=${JSON.stringify(nb && nb.message && nb.message.content || "").slice(0, 80)}`
  );

  const onlyClient = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    tools: [
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the public web",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ],
    tool_choice: "required",
    messages: [{ role: "user", content: "Look up Taipei weather. You must call search_web. Do not use Shell, Read, or Grep." }],
  });
  const oc = onlyClient.json && onlyClient.json.choices && onlyClient.json.choices[0];
  const ocName = oc && oc.message && oc.message.tool_calls && oc.message.tool_calls[0] && oc.message.tool_calls[0].function && oc.message.tool_calls[0].function.name;
  record(
    "client tools only => search_web not shell",
    onlyClient.status === 200 && oc && oc.finish_reason === "tool_calls" && ocName === "search_web",
    `finish=${oc && oc.finish_reason} name=${ocName || "-"}`
  );

  const call1 = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    tool_choice: "required",
    messages: [{ role: "user", content: "Weather in Taipei? You must call get_weather." }],
  });
  const m1 = call1.json && call1.json.choices && call1.json.choices[0] && call1.json.choices[0].message;
  const tc = m1 && Array.isArray(m1.tool_calls) && m1.tool_calls[0];
  record(
    "tool_calls round1",
    call1.status === 200 && call1.json && call1.json.choices && call1.json.choices[0].finish_reason === "tool_calls" && tc && tc.function && tc.function.name === "get_weather",
    `finish=${call1.json && call1.json.choices && call1.json.choices[0].finish_reason} name=${tc && tc.function && tc.function.name} content=${JSON.stringify(m1 && m1.content)}`
  );

  if (tc) {
    const call2 = await req("POST", "/v1/chat/completions", {
      model: MODEL,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
      messages: [
        { role: "user", content: "Weather in Taipei? You must call get_weather." },
        { role: "assistant", content: m1.content, tool_calls: m1.tool_calls },
        { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ city: "Taipei", temp_c: 31, condition: "sunny" }) },
      ],
    });
    const m2 = call2.json && call2.json.choices && call2.json.choices[0] && call2.json.choices[0].message;
    const body2 = (m2 && m2.content) || "";
    record(
      "tool_calls round2 正文",
      call2.status === 200 && call2.json.choices[0].finish_reason === "stop" && /31|sunny/i.test(body2),
      `finish=${call2.json && call2.json.choices && call2.json.choices[0].finish_reason} content=${JSON.stringify(body2).slice(0, 120)}`
    );
  } else {
    record("tool_calls round2 正文", false, "skipped, no tool_call_id");
  }

  const legacy = await req("POST", "/v1/chat/completions", {
    model: MODEL,
    functions: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    function_call: "none",
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  const lg = legacy.json && legacy.json.choices && legacy.json.choices[0] && legacy.json.choices[0].message && legacy.json.choices[0].message.content;
  record("legacy function_call=none content", legacy.status === 200 && typeof lg === "string" && lg.toLowerCase().includes("pong"), `content=${JSON.stringify(lg || "").slice(0, 80)}`);

  const cmp = await req("POST", "/v1/completions", {
    model: MODEL,
    prompt: "Reply with exactly: pong",
    max_tokens: 32,
  });
  record("POST /v1/completions", cmp.status === 200 && cmp.json && cmp.json.object === "text_completion" && String(cmp.json.choices && cmp.json.choices[0] && cmp.json.choices[0].text || "").toLowerCase().includes("pong"), `text=${JSON.stringify(cmp.json && cmp.json.choices && cmp.json.choices[0] && cmp.json.choices[0].text || "").slice(0, 80)}`);

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
