// Text-shaped tool calls for RPCs that only stream prose (or when a native
// toolCallPart never arrives). OpenAI clients still see tool_calls; the next
// turn re-POSTs role=tool history. Markers are recovered, not advertised, on
// the Inference path that already has a tools field.

const { v4: uuidv4 } = require("uuid");

function extractBalancedObject(s, from) {
  const start = s.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { json: s.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function asArgsString(args) {
  if (args == null) return "{}";
  if (typeof args === "string") {
    try {
      JSON.parse(args);
      return args;
    } catch {
      return JSON.stringify({ value: args });
    }
  }
  if (typeof args === "object") return JSON.stringify(args);
  return JSON.stringify({ value: args });
}

function makeCall(name, args) {
  if (!name) return null;
  return {
    id: `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: String(name), arguments: asArgsString(args) },
    _kind: "client_text",
  };
}

function objectToCall(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const candidate = obj.tool_call || obj.function_call || obj;
  const name = candidate.name || candidate.tool || candidate.function?.name;
  const hasArgs =
    candidate.arguments != null ||
    candidate.parameters != null ||
    candidate.args != null ||
    candidate.function?.arguments != null;
  if (!name || !hasArgs) return null;
  const args =
    candidate.arguments ||
    candidate.parameters ||
    candidate.args ||
    candidate.function?.arguments ||
    {};
  return makeCall(name, args);
}

function allowedName(name, allowed) {
  if (!allowed || !allowed.size) return true;
  return allowed.has(name);
}

// Models often emit Windows paths as C:\Users\... which is invalid JSON
// (\U is not an escape). Brace matching still works; parse needs repair.
function repairJsonEscapes(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      const n = s[i + 1];
      if (n === "u" && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) {
        out += ch;
        esc = true;
        continue;
      }
      if (n && '"\\/bfnrt'.includes(n)) {
        out += ch;
        esc = true;
        continue;
      }
      out += "\\\\";
      continue;
    }
    if (ch === '"') inStr = !inStr;
    out += ch;
  }
  return out;
}

function parseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(repairJsonEscapes(s));
  } catch {}
  return salvageJsonObject(s);
}

// {"command":"ls -la "/path"","description":"List ..."} — inner quotes break JSON.
// Split on `","` that introduces the next key.
function salvageJsonObject(s) {
  const t = String(s || "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  const inner = t.slice(1, -1);
  const chunks = inner.split(/"\s*,\s*"/);
  if (chunks.length < 1) return null;
  const out = {};
  for (let i = 0; i < chunks.length; i++) {
    let part = chunks[i];
    if (i > 0) part = `"${part}`;
    if (i < chunks.length - 1) part = `${part}"`;
    const m = part.match(/^"([^"]+)"\s*:\s*(.*)$/s);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    if (raw.startsWith('"')) {
      if (raw.endsWith('"')) raw = raw.slice(1, -1);
      else raw = raw.replace(/^"/, "").replace(/"$/, "");
      out[key] = raw.replace(/\\"/g, '"');
      continue;
    }
    const parsed = parseJsonLoose(raw);
    out[key] = parsed !== null ? parsed : raw;
  }
  return Object.keys(out).length ? out : null;
}

function pushCall(calls, obj, allowed) {
  if (Array.isArray(obj)) {
    let n = 0;
    for (const item of obj) if (pushCall(calls, item, allowed)) n += 1;
    return n > 0;
  }
  const call = objectToCall(obj);
  if (!call) return false;
  if (!allowedName(call.function.name, allowed)) return false;
  calls.push(call);
  return true;
}

function parseMarkedToolObjects(text, markerRe, allowed) {
  const calls = [];
  let out = "";
  let i = 0;
  const re = new RegExp(markerRe, "gi");
  let m;
  while ((m = re.exec(text))) {
    out += text.slice(i, m.index);
    const obj = extractBalancedObject(text, m.index + m[0].length);
    if (obj) {
      const parsed = parseJsonLoose(obj.json);
      // An explicit invoke_client_tool line is the protocol. Do not drop it
      // just because the name is not in the request's tools list — that left
      // the trigger sitting in assistant content and looked like a dead call.
      if (!parsed || !pushCall(calls, parsed, null)) out += text.slice(m.index, obj.end);
      i = obj.end;
      re.lastIndex = obj.end;
    } else {
      i = m.index;
      break;
    }
  }
  out += text.slice(i);
  return { text: out, calls };
}

function stripTag(working, re, allowed, calls) {
  return working.replace(re, (all, inner) => {
    const raw = String(inner || "").trim();
    const parsed = parseJsonLoose(raw);
    if (parsed && pushCall(calls, parsed, allowed)) return "";
    const obj = extractBalancedObject(raw, 0);
    if (obj) {
      const nested = parseJsonLoose(obj.json);
      if (nested && pushCall(calls, nested, allowed)) return "";
    }
    return all;
  });
}

function parseFencedJson(working, allowed, calls) {
  return working.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (all, inner) => {
    try {
      const parsed = parseJsonLoose(String(inner).trim());
      if (!parsed) return all;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.tool_calls)
          ? parsed.tool_calls
          : [parsed];
      let n = 0;
      for (const item of list) {
        if (pushCall(calls, item, allowed)) n += 1;
      }
      return n ? "" : all;
    } catch {
      return all;
    }
  });
}

function parseBareNameObjects(text, allowed) {
  if (!allowed || !allowed.size) return { text, calls: [] };
  const calls = [];
  let out = "";
  let i = 0;
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (/^(invoke_client_tool|CLIENT_TOOL|INVOKE_CLIENT_TOOL)$/i.test(name)) continue;
    if (!allowedName(name, allowed)) continue;
    const braceAt = m.index + m[0].length - 1;
    const obj = extractBalancedObject(text, braceAt);
    if (!obj) continue;
    out += text.slice(i, m.index);
    const parsed = parseJsonLoose(obj.json);
    const payload =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { _raw: obj.json };
    pushCall(calls, { name, arguments: payload }, allowed);
    i = obj.end;
    re.lastIndex = obj.end;
  }
  out += text.slice(i);
  return { text: out, calls };
}

function parseLabeledCommands(text, allowed) {
  if (!allowed || !allowed.size) return { text, calls: [] };
  const re =
    /(?:^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:命令)?[：:][ \t]*([^\n]*)\n+[ \t]*(?:```(?:bash|sh|zsh)?[ \t]*\n[ \t]*)?([^\n`]+)/g;
  const calls = [];
  const spans = [];
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (/^(invoke_client_tool|CLIENT_TOOL|INVOKE_CLIENT_TOOL)$/i.test(name)) continue;
    if (!allowedName(name, allowed)) continue;
    const command = (m[3] || "").trim();
    if (!command || command.startsWith("{")) continue;
    const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const end = m.index + m[0].length;
    const args = { command };
    const desc = (m[2] || "").trim();
    if (desc) args.description = desc;
    if (!pushCall(calls, { name, arguments: args }, allowed)) continue;
    spans.push({ start, end });
  }
  if (!spans.length) return { text, calls: [] };
  let out = "";
  let i = 0;
  for (const s of spans) {
    out += text.slice(i, s.start);
    i = s.end;
  }
  out += text.slice(i);
  return { text: out, calls };
}

function parseFunctionXml(working, allowed, calls) {
  return working.replace(
    /<function\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/function>/gi,
    (all, name, inner) => {
      if (!allowedName(name, allowed)) return all;
      const call = makeCall(name, String(inner).trim() || {});
      if (!call) return all;
      calls.push(call);
      return "";
    }
  );
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseParameterValue(inner) {
  const t = xmlUnescape(String(inner || "")).trim();
  if (!t) return "";
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    const parsed = parseJsonLoose(t);
    if (parsed !== null) return parsed;
  }
  return t;
}

function attrName(attrs) {
  const m = /(?:^|\s)name\s*=\s*["']([^"']+)["']/i.exec(String(attrs || ""));
  return m ? m[1] : "";
}

function harvestInvokes(inner, allowed, calls) {
  let n = 0;
  const re = /<(?:[a-zA-Z]+:)?invoke\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z]+:)?invoke>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const name = attrName(m[1]);
    if (!name) continue;
    const args = {};
    const pre = /<(?:[a-zA-Z]+:)?parameter\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z]+:)?parameter>/gi;
    let p;
    while ((p = pre.exec(m[2]))) {
      const pname = attrName(p[1]);
      if (pname) args[pname] = parseParameterValue(p[2]);
    }
    if (!Object.keys(args).length) {
      const json = parseJsonLoose(String(m[2] || "").trim());
      if (json && typeof json === "object" && !Array.isArray(json)) Object.assign(args, json);
    }
    if (pushCall(calls, { name, arguments: args }, allowed)) n += 1;
  }
  return n;
}

function parseAnthropicXml(working, allowed, calls) {
  let out = working;
  out = out.replace(
    /<(?:[a-zA-Z]+:)?function_calls\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?function_calls>/gi,
    (all, inner) => (harvestInvokes(inner, allowed, calls) ? "" : all)
  );
  out = out.replace(
    /<(?:[a-zA-Z]+:)?invoke\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z]+:)?invoke>/gi,
    (all, attrs, inner) => {
      const name = attrName(attrs);
      if (!name) return all;
      const args = {};
      const pre = /<(?:[a-zA-Z]+:)?parameter\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z]+:)?parameter>/gi;
      let p;
      while ((p = pre.exec(inner))) {
        const pname = attrName(p[1]);
        if (pname) args[pname] = parseParameterValue(p[2]);
      }
      if (!Object.keys(args).length) {
        const json = parseJsonLoose(String(inner || "").trim());
        if (json && typeof json === "object" && !Array.isArray(json)) Object.assign(args, json);
      }
      return pushCall(calls, { name, arguments: args }, allowed) ? "" : all;
    }
  );
  out = out.replace(
    /<(?:[a-zA-Z]+:)?tool_use\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?tool_use>/gi,
    (all, inner) => {
      const nameM = /<(?:[a-zA-Z]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?name>/i.exec(inner);
      const inputM = /<(?:[a-zA-Z]+:)?input\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?input>/i.exec(inner);
      const name = nameM ? xmlUnescape(nameM[1]).trim() : "";
      if (!name) return all;
      let args = {};
      if (inputM) {
        const parsed = parseJsonLoose(xmlUnescape(inputM[1]).trim());
        if (parsed && typeof parsed === "object") args = parsed;
        else args = { value: xmlUnescape(inputM[1]).trim() };
      }
      return pushCall(calls, { name, arguments: args }, allowed) ? "" : all;
    }
  );
  return out;
}

function formatXmlInvoke(toolName, args) {
  const obj = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const keys = Object.keys(obj);
  const body = keys
    .map((k) => {
      const v = obj[k];
      const inner = typeof v === "string" ? v : JSON.stringify(v);
      return `<parameter name="${xmlEscape(k)}">${xmlEscape(inner)}</parameter>`;
    })
    .join("\n");
  return `<invoke name="${xmlEscape(toolName)}">\n${body}\n</invoke>`;
}

function formatAnthropicInvokes(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  if (!list.length) return "";
  return `<function_calls>\n${list.map((c) => formatXmlInvoke(c.toolName || c.name, c.args || c.arguments)).join("\n")}\n</function_calls>`;
}

function formatAnthropicResults(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const blocks = list.map((p) => {
    const out = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
    const name = p.toolName ? ` name="${xmlEscape(p.toolName)}"` : "";
    const id = p.toolCallId ? ` tool_call_id="${xmlEscape(p.toolCallId)}"` : "";
    return `<result${name}${id}>\n${xmlEscape(out)}\n</result>`;
  });
  return `<function_results>\n${blocks.join("\n")}\n</function_results>`;
}

function allowedSet(options = {}) {
  if (options.allowed instanceof Set) return options.allowed;
  if (Array.isArray(options.allowed)) return new Set(options.allowed.filter(Boolean));
  if (Array.isArray(options.openaiTools)) {
    const names = [];
    for (const t of options.openaiTools) {
      const fn = t && (t.function || t);
      if (fn && fn.name) names.push(fn.name);
    }
    return names.length ? new Set(names) : null;
  }
  return null;
}

function parseTextToolCalls(text, options = {}) {
  if (!text) return { cleaned: text || "", calls: [] };
  if (options.toolChoice === "none") return { cleaned: text, calls: [] };
  const allowed = allowedSet(options);
  const calls = [];
  let working = text;

  working = parseAnthropicXml(working, allowed, calls);

  for (const marker of ["invoke_client_tool", "INVOKE_CLIENT_TOOL", "(?<![A-Za-z_])CLIENT_TOOL"]) {
    const parsed = parseMarkedToolObjects(working, marker + "\\b", allowed);
    calls.push(...parsed.calls);
    working = parsed.text;
  }

  working = stripTag(
    working,
    /<invoke_client_tool\b[^>]*>([\s\S]*?)<\/invoke_client_tool>/gi,
    null,
    calls
  );
  working = stripTag(working, /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi, allowed, calls);
  working = stripTag(working, /<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/gi, allowed, calls);
  working = parseFunctionXml(working, allowed, calls);
  working = parseFencedJson(working, allowed, calls);
  const bare = parseBareNameObjects(working, allowed);
  calls.push(...bare.calls);
  working = bare.text;
  const labeled = parseLabeledCommands(working, allowed);
  calls.push(...labeled.calls);
  working = labeled.text;

  let cleaned = working
    .replace(/CLIENT_TOOL\b|invoke_client_tool\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (calls.length && /你的客户端|注册的.*工具|请你确认客户端/i.test(cleaned) && cleaned.length < 80) {
    cleaned = "";
  }
  // Spliced protocol: an invoke_client_tool line *is* the turn. Leftover
  // chatter ("let me call the tool") must not become assistant content, or
  // clients think the call failed and print the trigger as prose.
  if (calls.length && options.protocolTurn) cleaned = "";

  const mapName = options.mapName;
  if (typeof mapName === "function") {
    for (const c of calls) c.function.name = mapName(c.function.name) || c.function.name;
  }
  return { cleaned, calls };
}

module.exports = {
  parseTextToolCalls,
  extractBalancedObject,
  objectToCall,
  xmlEscape,
  formatAnthropicInvokes,
  formatAnthropicResults,
};
