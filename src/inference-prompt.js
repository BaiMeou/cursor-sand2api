// InferenceService has a real SYSTEM role and a real `tools` field.
// AgentService did not: it composed its own prompt, injected Cursor builtins,
// and ignored role=system, so the converter had to smuggle instructions in as
// a fake user/assistant exchange plus a <client_runtime> HARD RULE. That
// inventory is wrong on this path — declaring no tools means the model has
// none, and the caller's system message should arrive as system.

const history = require("./history");

function entryText(entry) {
  if (!entry) return "";
  if (typeof entry.content === "string") return entry.content.trim();
  return history.textOf(entry.content).trim();
}

function buildInferenceTurn({
  messages,
  imagesAttached = false,
  documentsAttached = false,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const turn = history.buildTurnInput(list, {
    systemAsHistory: false,
    continuationPrompt: "",
    imagesAttached,
    documentsAttached,
  });

  const callerSystems = [];
  const rootMessages = [];
  for (const entry of turn.rootMessages) {
    if (entry && entry.role === "system") {
      const text = entryText(entry);
      if (text) callerSystems.push(text);
      continue;
    }
    rootMessages.push(entry);
  }

  return {
    systemText: callerSystems.join("\n\n"),
    rootMessages,
    userText: turn.userText || "",
  };
}

module.exports = {
  buildInferenceTurn,
};
