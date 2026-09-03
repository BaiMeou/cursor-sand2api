// The Responses API is a second dialect of the same conversation, not a second
// backend: `input` items instead of `messages`, its own usage spelling, and an
// output shaped as a list of items rather than a list of choices. Everything
// from prepareTurn() down is dialect-agnostic, so this module only translates
// at the two ends — in to chat shape, out to a `response` envelope.
//
// The stateful half of the API is deliberately not faked. Nothing here persists
// a response body, so `store` is answered honestly as false and retrieval is a
// separate 501 rather than a fabricated object.

const { v4: uuidv4 } = require("uuid");
const protocol = require("./openai-protocol");

const RESPONSES_PATH = "/v1/responses";

// Cursor's Run produces one turn, so one message item is always enough; the
// ids only have to be unique and stable within a single response.
function newId(prefix) {
  return `${prefix}_${uuidv4().replace(/-/g, "")}`;
}

function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// A function_call_output's `output` is a string in the common case, but the
// spec also allows the content-part array, and some clients send the raw object
// they got back from their tool.
function outputToText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((p) => (typeof p === "string" ? p : (p && (p.text || p.output_text)) || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (output && typeof output === "object") {
    if (typeof output.text === "string") return output.text;
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return output == null ? "" : String(output);
}

// Content parts pass through untouched: openai-map already reads input_text /
// input_image / input_file, and the attachment collectors already recognise the
// Responses spelling, so re-shaping them here would only lose information.
function contentOf(item) {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content;
  if (content == null) return "";
  return String(content);
}

// `input` accepts a bare string, message items, and the flat function_call /
// function_call_output items an agent loop replays between turns.
function inputToMessages(input) {
  if (input == null) return [];
  if (typeof input === "string") return input ? [{ role: "user", content: input }] : [];
  if (!Array.isArray(input)) return [{ role: "user", content: String(input) }];

  const messages = [];
  // Bare content parts at the top level belong to one implicit user turn, so
  // they accumulate instead of becoming one message each.
  let loose = null;
  const flush = () => {
    if (loose && loose.content.length) messages.push(loose);
    loose = null;
  };
  const collect = (part) => {
    if (!loose) loose = { role: "user", content: [] };
    loose.content.push(part);
  };
  // Parallel calls arrive as consecutive items but belong to one assistant
  // turn: splitting them would orphan every result but the first.
  const pushCall = (call) => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.tool_calls) && !last.__closed) {
      last.tool_calls.push(call);
      return;
    }
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
  };

  for (const raw of input) {
    if (typeof raw === "string") {
      collect({ type: "input_text", text: raw });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const type = str(raw.type);

    if (type === "function_call") {
      flush();
      pushCall({
        id: str(raw.call_id || raw.id),
        type: "function",
        function: { name: str(raw.name), arguments: str(raw.arguments) || "{}" },
      });
      continue;
    }
    if (type === "function_call_output") {
      flush();
      // Closes the assistant turn above it: anything after this is a new round.
      for (const m of messages) if (m.role === "assistant" && m.tool_calls) m.__closed = true;
      messages.push({
        role: "tool",
        tool_call_id: str(raw.call_id || raw.id),
        content: outputToText(raw.output),
      });
      continue;
    }
    // Reasoning items are the model's own scratch space echoed back. There is
    // no way to replay them into Cursor, and rendering them as user text would
    // put words in the caller's mouth.
    if (type === "reasoning" || type === "item_reference") continue;

    if (type === "message" || raw.role) {
      flush();
      const role = str(raw.role) || "user";
      messages.push({ role, content: contentOf(raw) });
      continue;
    }
    // Anything left is a bare content part.
    collect(raw);
  }
  flush();
  for (const m of messages) delete m.__closed;
  return messages;
}

// Responses spells tool_choice `{type:"function", name}`; chat nests the name
// one level deeper. Built-in tool choices have no equivalent here.
function toolChoiceToChat(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (typeof choice !== "object") return undefined;
  if (choice.type === "function") {
    const name = str(choice.name || (choice.function && choice.function.name));
    return name ? { type: "function", function: { name } } : "auto";
  }
  if (choice.type === "allowed_tools") return "auto";
  return "auto";
}

// Responses declares functions flat (`{type:"function", name, parameters}`).
// openai-map reads `t.function?.name || t.name`, so a flat tool already works
// end to end and is left as-is; only the hosted tools have to go, since this
// proxy cannot run them and Cursor would reject the unknown shape.
function toolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const kept = tools.filter((t) => t && (t.type === "function" || t.type === undefined || t.function));
  return kept.length ? kept : undefined;
}

function hostedTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && t.type && t.type !== "function" && !t.function)
    .map((t) => str(t.type));
}

// Responses moved response_format under `text.format` and renamed the schema
// keys; hintPrefix only knows the chat spelling.
function textFormatToResponseFormat(text) {
  const format = text && typeof text === "object" ? text.format : null;
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: str(format.name) || "response",
        schema: format.schema || format.json_schema || {},
        strict: format.strict === true,
      },
    };
  }
  return undefined;
}

function responsesToChat(body) {
  const src = body && typeof body === "object" ? body : {};
  const messages = [];
  // `instructions` is the Responses spelling of a system turn, and it applies
  // ahead of everything in `input`.
  const instructions = str(src.instructions).trim();
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...inputToMessages(src.input));
  // validateResponsesRequest has already refused a genuinely empty input; this
  // floor only covers an input that held nothing but reasoning items.
  if (!messages.some((m) => m.role !== "system")) {
    messages.push({ role: "user", content: " " });
  }

  const chat = {
    model: src.model,
    stream: src.stream === true,
    messages,
    max_tokens: src.max_output_tokens,
    temperature: src.temperature,
    top_p: src.top_p,
    user: src.user,
    parallel_tool_calls: src.parallel_tool_calls,
    metadata: src.metadata,
  };
  const tools = toolsToChat(src.tools);
  if (tools) chat.tools = tools;
  const toolChoice = toolChoiceToChat(src.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  const responseFormat = textFormatToResponseFormat(src.text);
  if (responseFormat) chat.response_format = responseFormat;
  if (src.reasoning && typeof src.reasoning === "object" && src.reasoning.effort) {
    chat.reasoning_effort = src.reasoning.effort;
  }
  // The session map is keyed by Cursor's conversation id, and that is what a
  // response id stands in for here, so a follow-up lands on the parked stream.
  if (src.previous_response_id) chat.conversation_id = src.previous_response_id;
  if (src.stream_options) chat.stream_options = src.stream_options;
  return chat;
}

function validateResponsesRequest(body) {
  if (!body || typeof body !== "object") {
    return { error: { message: "request body is required", type: "invalid_request_error", param: null, code: 400 } };
  }
  if (body.background === true) {
    return protocol.notImplemented("background responses", "background");
  }
  const hosted = hostedTools(body.tools);
  if (hosted.length) {
    return protocol.notImplemented(`hosted tools (${hosted.join(", ")})`, "tools");
  }
  const input = body.input;
  const empty =
    input == null || (typeof input === "string" && !input) || (Array.isArray(input) && input.length === 0);
  if (empty && !str(body.instructions).trim()) {
    return { error: { message: "input is required", type: "invalid_request_error", param: "input", code: 400 } };
  }
  return null;
}

// Responses renames every usage field and nests the details differently. The
// stream already holds a chat-shaped usage by the time it finishes, so the
// rename is split out from the event reader.
function usageFromChat(chat = {}) {
  const usage = {
    input_tokens: chat.prompt_tokens,
    output_tokens: chat.completion_tokens,
    total_tokens: chat.total_tokens,
    input_tokens_details: { cached_tokens: (chat.prompt_tokens_details || {}).cached_tokens || 0 },
    output_tokens_details: {
      reasoning_tokens: (chat.completion_tokens_details || {}).reasoning_tokens || 0,
    },
  };
  const created = (chat.prompt_tokens_details || {}).cache_creation_tokens;
  if (created) usage.input_tokens_details.cache_creation_tokens = created;
  return usage;
}

function usageFrom(ev) {
  return usageFromChat(protocol.usageFrom(ev));
}

function messageItem(text, id) {
  return {
    type: "message",
    id: id || newId("msg"),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: str(text), annotations: [] }],
  };
}

function functionCallItem(call, id) {
  return {
    type: "function_call",
    id: id || newId("fc"),
    call_id: str(call.id) || newId("call"),
    name: str(call.function && call.function.name),
    arguments: str(call.function && call.function.arguments) || "{}",
    status: "completed",
  };
}

// The model's own thinking, kept as a summary item because that is the only
// place the Responses shape has for it.
function reasoningItem(thinking, id) {
  return {
    type: "reasoning",
    id: id || newId("rs"),
    summary: [{ type: "summary_text", text: str(thinking) }],
  };
}

function outputItems({ content, reasoning, toolCalls }) {
  const output = [];
  if (reasoning) output.push(reasoningItem(reasoning));
  if (content) output.push(messageItem(content));
  for (const call of toolCalls || []) output.push(functionCallItem(call));
  return output;
}

// `incomplete` is the Responses spelling of finish_reason=length, and it is the
// only way a caller learns the answer was cut rather than finished.
function statusFor(finishReason) {
  return finishReason === "length" ? "incomplete" : "completed";
}

function buildResponse({ id, model, output, usage, request = {}, status = "completed", finishReason, extra = {} }) {
  const body = {
    id: id || newId("resp"),
    object: "response",
    created_at: extra.created || Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    instructions: request.instructions == null ? null : request.instructions,
    max_output_tokens: request.max_output_tokens == null ? null : request.max_output_tokens,
    model,
    output: output || [],
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: request.previous_response_id || null,
    reasoning: { effort: (request.reasoning && request.reasoning.effort) || null, summary: null },
    // Nothing on this side keeps the body, so claiming otherwise would promise a
    // retrieval endpoint that cannot answer.
    store: false,
    temperature: request.temperature == null ? null : request.temperature,
    text: request.text || { format: { type: "text" } },
    tool_choice: request.tool_choice == null ? "auto" : request.tool_choice,
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: request.top_p == null ? null : request.top_p,
    truncation: "disabled",
    usage: usage || usageFrom(null),
    user: request.user || null,
    metadata: request.metadata || {},
  };
  // The SDKs expose `output_text` as a convenience over the item list; sending
  // it costs nothing and spares thin clients the walk.
  body.output_text = (body.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content || []).map((p) => str(p.text)))
    .join("");
  if (extra.conversationId) body.conversation_id = extra.conversationId;
  if (extra.ignoredParams && extra.ignoredParams.length) body.cursor_ignored_params = extra.ignoredParams;
  if (finishReason) body.cursor_finish_reason = finishReason;
  return body;
}

// The non-streaming exit: the pipeline has already built a chat body, so the
// assistant fields are read back out of it rather than recomputed.
function toResponse(chatBody, model, options = {}) {
  const choice = (chatBody.choices && chatBody.choices[0]) || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || "stop";
  const output = outputItems({
    content: message.content,
    reasoning: message.reasoning_content,
    toolCalls: message.tool_calls,
  });
  return buildResponse({
    id: str(chatBody.id).replace(/^chatcmpl-/, "resp_"),
    model,
    output,
    usage: usageFrom(options.usageDetails),
    request: options.request || {},
    status: statusFor(finishReason),
    finishReason,
    extra: {
      created: chatBody.created,
      conversationId: options.conversationId,
      ignoredParams: options.ignoredParams,
    },
  });
}

module.exports = {
  RESPONSES_PATH,
  responsesToChat,
  validateResponsesRequest,
  inputToMessages,
  toolChoiceToChat,
  toolsToChat,
  hostedTools,
  textFormatToResponseFormat,
  outputToText,
  usageFrom,
  usageFromChat,
  buildResponse,
  outputItems,
  messageItem,
  functionCallItem,
  reasoningItem,
  statusFor,
  toResponse,
  newId,
};
