// cursor-sand2api web console.
//
// Talks to the proxy's own OpenAI surface — /v1/models, /v1/chat/completions,
// /health — so nothing here knows anything about Cursor. State lives in
// localStorage; there is no server-side session.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "sand2api.state.v1";
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_DOC_BYTES = 10 * 1024 * 1024;

  const el = {
    sidebar: $("sidebar"),
    convList: $("conversation-list"),
    newChat: $("new-chat"),
    messages: $("messages"),
    welcome: $("welcome"),
    input: $("input"),
    send: $("send"),
    stop: $("stop"),
    composer: $("composer"),
    attachBtn: $("attach-btn"),
    fileInput: $("file-input"),
    attachments: $("attachments"),
    modelBtn: $("model-btn"),
    modelName: $("model-name"),
    modelMenu: $("model-menu"),
    modelSearch: $("model-search"),
    modelOptions: $("model-options"),
    params: $("params"),
    toggleParams: $("toggle-params"),
    toggleTheme: $("toggle-theme"),
    toggleSidebar: $("toggle-sidebar"),
    turnUsage: $("turn-usage"),
    healthDot: $("health-dot"),
    healthText: $("health-text"),
    settings: $("settings"),
    openSettings: $("open-settings"),
    toast: $("toast"),
    p: {
      system: $("p-system"),
      maxTokens: $("p-maxtokens"),
      temperature: $("p-temperature"),
      effort: $("p-effort"),
      format: $("p-format"),
      stop: $("p-stop"),
    },
    s: {
      apiKey: $("s-apikey"),
      base: $("s-base"),
      stream: $("s-stream"),
      thinking: $("s-thinking"),
      health: $("s-health"),
      clear: $("s-clear"),
    },
  };

  // ---------- state ----------

  const defaults = () => ({
    theme: "dark",
    apiKey: "",
    base: "",
    stream: true,
    showThinking: true,
    model: "",
    params: { system: "", maxTokens: "", temperature: "", effort: "", format: "", stop: "" },
    conversations: [],
    activeId: "",
  });

  let state = load();
  let models = [];
  let pending = null; // AbortController for the turn in flight
  let drafts = []; // attachments staged for the next message

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaults();
      return Object.assign(defaults(), JSON.parse(raw));
    } catch {
      return defaults();
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } catch (e) {
        // Attachments are held as data URLs, so a long image-heavy history can
        // outgrow the quota. Losing the newest turn is better than silence.
        toast("浏览器存储已满，历史可能未完整保存");
      }
    }, 250);
  }

  function activeConv() {
    return state.conversations.find((c) => c.id === state.activeId) || null;
  }

  function newConversation() {
    const conv = { id: `c${Date.now().toString(36)}`, title: "新对话", messages: [], createdAt: Date.now() };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    save();
    return conv;
  }

  function ensureConv() {
    return activeConv() || newConversation();
  }

  // ---------- helpers ----------

  function toast(text, ms = 2600) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.hidden = true;
    }, ms);
  }

  function apiBase() {
    return String(state.base || "").replace(/\/+$/, "");
  }

  function authHeaders(extra) {
    const headers = Object.assign({}, extra);
    if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
    return headers;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function scrollToBottom(force) {
    const box = el.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- attachments ----------

  async function addFiles(files) {
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const cap = isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;
      if (file.size > cap) {
        toast(`${file.name} 超过 ${formatBytes(cap)} 上限，已跳过`);
        continue;
      }
      try {
        const url = await readAsDataUrl(file);
        drafts.push({ kind: isImage ? "image" : "doc", name: file.name, size: file.size, url });
      } catch {
        toast(`${file.name} 读取失败`);
      }
    }
    renderDrafts();
  }

  function renderDrafts() {
    el.attachments.innerHTML = "";
    el.attachments.hidden = drafts.length === 0;
    drafts.forEach((att, index) => {
      const box = document.createElement("div");
      box.className = att.kind === "image" ? "attachment" : "attachment doc";
      if (att.kind === "image") {
        const img = document.createElement("img");
        img.src = att.url;
        img.alt = att.name;
        box.appendChild(img);
      } else {
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = att.name;
        const size = document.createElement("span");
        size.className = "size";
        size.textContent = formatBytes(att.size);
        box.append(name, size);
      }
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "移除";
      remove.addEventListener("click", () => {
        drafts.splice(index, 1);
        renderDrafts();
      });
      box.appendChild(remove);
      el.attachments.appendChild(box);
    });
  }

  // A stored message keeps its attachments so a reload still shows them, and so
  // a regenerate can replay the exact same turn.
  function contentForApi(msg) {
    if (!msg.attachments || !msg.attachments.length) return msg.content;
    const parts = [];
    if (msg.content) parts.push({ type: "text", text: msg.content });
    for (const att of msg.attachments) {
      if (att.kind === "image") parts.push({ type: "image_url", image_url: { url: att.url } });
      else parts.push({ type: "file", file: { filename: att.name, file_data: att.url } });
    }
    return parts;
  }

  // ---------- models ----------

  let modelError = "";

  async function loadModels() {
    try {
      const res = await fetch(`${apiBase()}/v1/models`, { headers: authHeaders() });
      // 401 is what an unconfigured console looks like, and "unavailable" sends
      // people hunting for a server problem that is really a missing key.
      if (res.status === 401) throw new Error("需要 API Key —— 打开设置填写");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      modelError = "";
      const body = await res.json();
      models = Array.isArray(body.data) ? body.data : [];
      if (!state.model && models.length) state.model = models[0].id;
      if (state.model && !models.some((m) => m.id === state.model)) {
        // The saved model is gone from the account; keep the name visible
        // rather than silently switching what the next turn runs on.
        models.unshift({ id: state.model, missing: true });
      }
      renderModelName();
      renderModelOptions();
    } catch (e) {
      modelError = String(e.message || e);
      el.modelName.textContent = state.model || "模型列表不可用";
      renderModelOptions();
    }
  }

  function renderModelName() {
    el.modelName.textContent = state.model || "选择模型";
  }

  function renderModelOptions() {
    const q = el.modelSearch.value.trim().toLowerCase();
    const list = models.filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.display_name || "").toLowerCase().includes(q));
    el.modelOptions.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = models.length ? "没有匹配的模型" : modelError || "拉取模型列表失败，检查 API Key 与服务地址";
      el.modelOptions.appendChild(empty);
      return;
    }
    for (const model of list.slice(0, 300)) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `model-option${model.id === state.model ? " active" : ""}`;

      const top = document.createElement("div");
      top.className = "model-option-top";
      const id = document.createElement("span");
      id.className = "model-option-id";
      id.textContent = model.display_name ? `${model.display_name}` : model.id;
      top.appendChild(id);
      option.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "model-option-meta";
      const tags = [];
      if (model.display_name && model.display_name !== model.id) tags.push([model.id, false]);
      if (model.context_window) tags.push([`${Math.round(model.context_window / 1000)}k`, false]);
      if (model.supports_images) tags.push(["图片", true]);
      if (model.supports_thinking) tags.push(["思考", true]);
      if (model.supports_max_mode) tags.push(["max", true]);
      // Upstream still runs some names GetUsableModels omits, so this is a
      // caveat rather than a verdict.
      if (model.missing) tags.push(["不在账号列表，仍可尝试", false]);
      for (const [text, on] of tags) {
        const tag = document.createElement("span");
        tag.className = on ? "tag on" : "tag";
        tag.textContent = text;
        meta.appendChild(tag);
      }
      if (meta.children.length) option.appendChild(meta);

      option.addEventListener("click", () => {
        state.model = model.id;
        save();
        renderModelName();
        closeModelMenu();
      });
      el.modelOptions.appendChild(option);
    }
  }

  function openModelMenu() {
    el.modelMenu.hidden = false;
    el.modelBtn.setAttribute("aria-expanded", "true");
    el.modelSearch.value = "";
    renderModelOptions();
    el.modelSearch.focus();
  }

  function closeModelMenu() {
    el.modelMenu.hidden = true;
    el.modelBtn.setAttribute("aria-expanded", "false");
  }

  // ---------- health ----------

  async function loadHealth() {
    try {
      const res = await fetch(`${apiBase()}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const tokens = body.tokens || {};
      const ok = body.status === "ok";
      el.healthDot.className = `dot ${ok ? "ok" : "bad"}`;
      el.healthText.textContent = `${body.status} · ${tokens.healthy ?? "?"}/${tokens.total ?? "?"} 账号`;
      let detail = body;
      if (state.apiKey) {
        const det = await fetch(`${apiBase()}/health/detail`, { headers: authHeaders() });
        if (det.ok) detail = await det.json();
      }
      el.s.health.textContent = JSON.stringify(detail, null, 2);
    } catch (e) {
      el.healthDot.className = "dot bad";
      el.healthText.textContent = "服务不可达";
      el.s.health.textContent = String(e.message || e);
    }
  }

  // ---------- rendering ----------

  function renderConversations() {
    el.convList.innerHTML = "";
    for (const conv of state.conversations) {
      const row = document.createElement("div");
      row.className = `conv${conv.id === state.activeId ? " active" : ""}`;

      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conv.title || "新对话";
      row.appendChild(title);

      const del = document.createElement("button");
      del.className = "conv-del";
      del.type = "button";
      del.title = "删除";
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        state.conversations = state.conversations.filter((c) => c.id !== conv.id);
        if (state.activeId === conv.id) state.activeId = state.conversations[0]?.id || "";
        save();
        renderConversations();
        renderMessages();
      });
      row.appendChild(del);

      row.addEventListener("click", () => {
        if (pending) return toast("当前回答还在生成");
        state.activeId = conv.id;
        save();
        renderConversations();
        renderMessages();
      });
      el.convList.appendChild(row);
    }
  }

  function attachmentsNode(list) {
    const box = document.createElement("div");
    box.className = "msg-attachments";
    for (const att of list) {
      if (att.kind === "image") {
        const img = document.createElement("img");
        img.src = att.url;
        img.alt = att.name;
        box.appendChild(img);
      } else {
        const chip = document.createElement("span");
        chip.className = "file-chip";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = att.name;
        const size = document.createElement("span");
        size.className = "size";
        size.textContent = formatBytes(att.size);
        chip.append(name, size);
        box.appendChild(chip);
      }
    }
    return box;
  }

  function bindCopyButtons(root) {
    for (const btn of root.querySelectorAll("[data-copy]")) {
      btn.addEventListener("click", () => {
        const block = btn.closest(".code-block");
        const code = decodeURIComponent(block.dataset.code || "");
        navigator.clipboard.writeText(code).then(
          () => {
            btn.textContent = "已复制";
            setTimeout(() => (btn.textContent = "复制"), 1400);
          },
          () => toast("复制失败")
        );
      });
    }
  }

  function messageNode(msg, index) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${msg.role}`;

    const head = document.createElement("div");
    head.className = "msg-role";
    const label = document.createElement("span");
    label.textContent = msg.role === "user" ? "你" : msg.model || "助手";
    head.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(msg.content || "").then(
        () => toast("已复制"),
        () => toast("复制失败")
      );
    });
    actions.appendChild(copy);

    if (msg.role === "user") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        if (pending) return toast("当前回答还在生成");
        const conv = activeConv();
        el.input.value = msg.content || "";
        drafts = (msg.attachments || []).slice();
        conv.messages.splice(index);
        save();
        renderMessages();
        renderDrafts();
        autosize();
        el.input.focus();
      });
      actions.appendChild(edit);
    } else {
      const again = document.createElement("button");
      again.type = "button";
      again.textContent = "重新生成";
      again.addEventListener("click", () => regenerate(index));
      actions.appendChild(again);
    }

    head.appendChild(actions);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "msg-body";

    if (msg.attachments && msg.attachments.length) body.appendChild(attachmentsNode(msg.attachments));

    if (msg.reasoning && state.showThinking) {
      const details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      summary.textContent = "思考过程";
      const inner = document.createElement("div");
      inner.className = "thinking-body";
      inner.textContent = msg.reasoning;
      details.append(summary, inner);
      body.appendChild(details);
    }

    if (msg.toolCalls && msg.toolCalls.length) {
      for (const call of msg.toolCalls) {
        const box = document.createElement("div");
        box.className = "tool-call";
        const fn = document.createElement("span");
        fn.className = "fn";
        fn.textContent = call.function?.name || "tool";
        box.append(fn, document.createTextNode(`(${call.function?.arguments || ""})`));
        body.appendChild(box);
      }
    }

    if (msg.content) {
      const text = document.createElement("div");
      text.className = "md";
      text.innerHTML = window.md.render(msg.content);
      bindCopyButtons(text);
      body.appendChild(text);
    }

    if (msg.error) {
      const err = document.createElement("div");
      err.className = "msg-error";
      err.textContent = msg.error;
      body.appendChild(err);
    }

    wrap.appendChild(body);
    return wrap;
  }

  function renderMessages() {
    const conv = activeConv();
    el.messages.innerHTML = "";
    if (!conv || !conv.messages.length) {
      el.messages.appendChild(el.welcome);
      el.welcome.hidden = false;
      el.turnUsage.hidden = true;
      return;
    }
    const inner = document.createElement("div");
    inner.className = "messages-inner";
    conv.messages.forEach((msg, i) => inner.appendChild(messageNode(msg, i)));
    el.messages.appendChild(inner);
    scrollToBottom(true);
  }

  // ---------- streaming ----------

  function buildRequestBody(messages) {
    const body = {
      model: state.model,
      messages,
      stream: state.stream,
    };
    const p = state.params;
    if (p.system && p.system.trim()) body.messages = [{ role: "system", content: p.system.trim() }, ...messages];
    const maxTokens = parseInt(p.maxTokens, 10);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const temperature = parseFloat(p.temperature);
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (p.effort) body.reasoning_effort = p.effort;
    if (p.format === "json_object") body.response_format = { type: "json_object" };
    const stops = String(p.stop || "")
      .split(",")
      .map((s) => s.trim().replace(/\\n/g, "\n"))
      .filter(Boolean);
    if (stops.length) body.stop = stops;
    if (state.stream) body.stream_options = { include_usage: true };
    return body;
  }

  // The chat stream is a sequence of `data:` frames; a frame can be split
  // across network chunks, so the tail is carried over rather than parsed.
  async function* sseFrames(response, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {}
        }
      }
    } finally {
      if (signal && signal.aborted) {
        try {
          await reader.cancel();
        } catch {}
      }
    }
  }

  function usageText(usage) {
    if (!usage) return "";
    const bits = [`${usage.prompt_tokens ?? 0} in`, `${usage.completion_tokens ?? 0} out`];
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    if (reasoning) bits.push(`${reasoning} 思考`);
    const cached = usage.prompt_tokens_details?.cached_tokens;
    if (cached) bits.push(`${cached} 缓存`);
    return bits.join(" · ");
  }

  async function runTurn(conv, assistant, node) {
    const apiMessages = [];
    for (const m of conv.messages) {
      if (m === assistant) continue;
      if (m.role === "assistant" && !m.content && !m.toolCalls) continue;
      apiMessages.push({ role: m.role, content: contentForApi(m) });
    }

    pending = new AbortController();
    el.send.hidden = true;
    el.stop.hidden = false;

    const body = buildRequestBody(apiMessages);
    const bodyEl = node.querySelector(".msg-body");
    let textEl = null;
    let thinkingEl = null;
    let caret = null;

    const ensureText = () => {
      if (textEl) return textEl;
      textEl = document.createElement("div");
      textEl.className = "md";
      bodyEl.appendChild(textEl);
      return textEl;
    };
    const ensureThinking = () => {
      if (thinkingEl) return thinkingEl;
      const details = document.createElement("details");
      details.className = "thinking";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = "思考中…";
      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking-body";
      details.append(summary, thinkingEl);
      details._summary = summary;
      bodyEl.insertBefore(details, bodyEl.firstChild);
      thinkingEl._details = details;
      return thinkingEl;
    };
    const paint = () => {
      const target = ensureText();
      target.innerHTML = window.md.render(assistant.content);
      if (!caret) {
        caret = document.createElement("span");
        caret.className = "cursor-blink";
      }
      target.appendChild(caret);
      scrollToBottom();
    };

    try {
      const res = await fetch(`${apiBase()}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        signal: pending.signal,
      });

      if (!res.ok && !state.stream) {
        const problem = await res.json().catch(() => null);
        throw new Error(problem?.error?.message || `HTTP ${res.status}`);
      }

      if (!state.stream) {
        const json = await res.json();
        const choice = json.choices?.[0]?.message || {};
        assistant.content = choice.content || "";
        assistant.reasoning = choice.reasoning_content || "";
        assistant.toolCalls = choice.tool_calls || null;
        assistant.usage = json.usage || null;
      } else {
        // A refusal that arrives before the first token comes back as a normal
        // error body with a real status, not as a stream.
        if (!res.ok || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
          const problem = await res.json().catch(() => null);
          throw new Error(problem?.error?.message || `HTTP ${res.status}`);
        }
        for await (const frame of sseFrames(res, pending.signal)) {
          if (frame.error) throw new Error(frame.error.message || "上游错误");
          if (frame.usage) assistant.usage = frame.usage;
          const delta = frame.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            assistant.reasoning = (assistant.reasoning || "") + delta.reasoning_content;
            ensureThinking().textContent = assistant.reasoning;
            scrollToBottom();
          }
          if (delta.content) {
            assistant.content = (assistant.content || "") + delta.content;
            paint();
          }
          if (delta.tool_calls) {
            assistant.toolCalls = assistant.toolCalls || [];
            for (const call of delta.tool_calls) {
              const at = call.index ?? assistant.toolCalls.length;
              const prev = assistant.toolCalls[at] || { function: { name: "", arguments: "" } };
              assistant.toolCalls[at] = {
                id: call.id || prev.id,
                function: {
                  name: call.function?.name || prev.function.name,
                  arguments: (prev.function.arguments || "") + (call.function?.arguments || ""),
                },
              };
            }
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        assistant.stopped = true;
        if (!assistant.content) assistant.content = "_（已停止）_";
      } else {
        assistant.error = String(e.message || e);
      }
    } finally {
      pending = null;
      el.send.hidden = false;
      el.stop.hidden = true;
      if (thinkingEl && thinkingEl._details) {
        thinkingEl._details._summary.textContent = "思考过程";
        thinkingEl._details.open = false;
      }
      if (caret) caret.remove();
      if (assistant.usage) {
        el.turnUsage.textContent = usageText(assistant.usage);
        el.turnUsage.hidden = false;
      }
      save();
      renderMessages();
    }
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text && !drafts.length) return;
    if (pending) return;
    if (!state.model) {
      toast("先选一个模型");
      return openModelMenu();
    }

    const conv = ensureConv();
    if (conv.messages.length === 0) {
      conv.title = (text || drafts[0]?.name || "新对话").slice(0, 40);
    }
    conv.messages.push({ role: "user", content: text, attachments: drafts.slice() });
    drafts = [];
    el.input.value = "";
    renderDrafts();
    autosize();

    const assistant = { role: "assistant", content: "", model: state.model };
    conv.messages.push(assistant);
    save();
    renderConversations();
    renderMessages();

    const node = el.messages.querySelector(".messages-inner").lastElementChild;
    await runTurn(conv, assistant, node);
  }

  async function regenerate(index) {
    if (pending) return toast("当前回答还在生成");
    const conv = activeConv();
    if (!conv) return;
    conv.messages.splice(index);
    const assistant = { role: "assistant", content: "", model: state.model };
    conv.messages.push(assistant);
    save();
    renderMessages();
    const node = el.messages.querySelector(".messages-inner").lastElementChild;
    await runTurn(conv, assistant, node);
  }

  // ---------- composer ----------

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
  }

  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  el.send.addEventListener("click", send);
  el.stop.addEventListener("click", () => {
    if (pending) pending.abort();
  });

  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", async () => {
    await addFiles(Array.from(el.fileInput.files || []));
    el.fileInput.value = "";
  });

  el.input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  for (const type of ["dragenter", "dragover"]) {
    el.composer.addEventListener(type, (e) => {
      e.preventDefault();
      el.composer.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    el.composer.addEventListener(type, (e) => {
      e.preventDefault();
      el.composer.classList.remove("dragging");
    });
  }
  el.composer.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) addFiles(files);
  });

  // ---------- chrome ----------

  el.newChat.addEventListener("click", () => {
    if (pending) return toast("当前回答还在生成");
    newConversation();
    renderConversations();
    renderMessages();
    el.input.focus();
  });

  el.modelBtn.addEventListener("click", () => {
    if (el.modelMenu.hidden) openModelMenu();
    else closeModelMenu();
  });
  el.modelSearch.addEventListener("input", renderModelOptions);
  document.addEventListener("click", (e) => {
    // A click can land on the document or a text node, neither of which has
    // closest(); treating that as "outside" is the right answer anyway.
    const target = e.target instanceof Element ? e.target : null;
    if (!el.modelMenu.hidden && !(target && target.closest("#model-picker"))) closeModelMenu();
  });

  el.toggleParams.addEventListener("click", () => {
    el.params.hidden = !el.params.hidden;
  });

  el.toggleTheme.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    save();
  });

  el.toggleSidebar.addEventListener("click", () => el.sidebar.classList.toggle("hidden"));

  el.openSettings.addEventListener("click", () => {
    loadHealth();
    el.settings.showModal();
  });

  el.settings.addEventListener("close", () => {
    state.apiKey = el.s.apiKey.value.trim();
    state.base = el.s.base.value.trim();
    state.stream = el.s.stream.checked;
    state.showThinking = el.s.thinking.checked;
    save();
    renderMessages();
    loadModels();
    loadHealth();
  });

  el.s.clear.addEventListener("click", () => {
    if (!confirm("删除全部对话？此操作不可撤销。")) return;
    state.conversations = [];
    state.activeId = "";
    save();
    renderConversations();
    renderMessages();
    toast("已清空");
  });

  for (const [key, node] of Object.entries(el.p)) {
    node.addEventListener("change", () => {
      state.params[key] = node.value;
      save();
    });
  }

  el.welcome.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const tip = target && target.closest(".tip");
    if (!tip) return;
    el.input.value = tip.dataset.prompt || "";
    autosize();
    el.input.focus();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      el.newChat.click();
    }
    if (e.key === "Escape" && !el.modelMenu.hidden) closeModelMenu();
  });

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    el.toggleTheme.querySelector("svg").innerHTML =
      state.theme === "dark"
        ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />'
        : '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />';
  }

  // ---------- boot ----------

  function boot() {
    applyTheme();
    el.s.apiKey.value = state.apiKey;
    el.s.base.value = state.base;
    el.s.stream.checked = state.stream;
    el.s.thinking.checked = state.showThinking;
    for (const [key, node] of Object.entries(el.p)) node.value = state.params[key] || "";

    renderConversations();
    renderMessages();
    renderDrafts();
    autosize();
    loadModels();
    loadHealth();
    setInterval(loadHealth, 30000);
    el.input.focus();
  }

  boot();
})();
