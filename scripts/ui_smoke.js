#!/usr/bin/env node
// Drives the web console in a headless Chromium over the DevTools protocol and
// writes screenshots to scripts/shots/. No test dependencies: CDP is a
// WebSocket, and Node has had one built in since 22.
//
//   node scripts/ui_smoke.js
//   BASE=http://127.0.0.1:13000 API_KEY=devkey node scripts/ui_smoke.js
//   KEEP=1 node scripts/ui_smoke.js     # leave the browser open

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:13000";
const API_KEY = process.env.API_KEY || "devkey";
const MODEL = process.env.MODEL || "claude-4.5-haiku";
// kimi cannot see images, and the default model is kimi, so the vision leg
// needs a model the catalog marks as supporting them.
const VISION_MODEL = process.env.VISION_MODEL || "claude-4.5-sonnet";
const PORT = parseInt(process.env.CDP_PORT || "9333", 10);
const SHOTS = path.join(__dirname, "shots");

const BROWSERS = [
  path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of BROWSERS) if (p && fs.existsSync(p)) return p;
  return null;
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error("devtools endpoint never came up");
}

// A very small CDP client: send a method, resolve when the matching id returns.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.params || {})})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 60000);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  // Polls in the page rather than sleeping blind, so a slow model does not
  // turn into a flaky assertion.
  async waitFor(expression, { timeoutMs = 90000, label = expression } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.eval(`Boolean(${expression})`)) return true;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, "base64"));
    console.log(`       shot: ${path.relative(process.cwd(), file)}`);
    return file;
  }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error("no Chrome or Edge found; set one of the paths in BROWSERS");
    process.exit(1);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  // A throwaway profile keeps this out of the real browser's history and
  // guarantees a clean localStorage every run.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sand2api-ui-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,940",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );

  let cdp = null;
  try {
    await waitForDevtools(PORT);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable").catch(() => {});

    const consoleErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        consoleErrors.push(msg.params.entry.text);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params.exceptionDetails.exception?.description || "exception");
      }
    });

    console.log(`\nloading ${BASE}`);
    await cdp.send("Page.navigate", { url: BASE });
    await cdp.waitFor("document.readyState === 'complete'", { timeoutMs: 20000, label: "page load" });
    await sleep(1200);

    // A console with no key saved is the first thing a new user sees, and the
    // proxy answers 401. The page has to say what to do about it.
    console.log("\nunconfigured state");
    await cdp.eval("document.getElementById('model-btn').click()");
    await sleep(300);
    const unconfigured = await cdp.eval("(document.querySelector('.model-empty')||{}).textContent || ''");
    check("explains a missing API key", /API Key/i.test(unconfigured), unconfigured);
    await cdp.eval("document.getElementById('model-btn').click()");
    await sleep(150);

    // Seed the key the same way the settings dialog would, then reload so the
    // app boots with it.
    await cdp.eval(`(() => {
      const raw = localStorage.getItem("sand2api.state.v1");
      const s = raw ? JSON.parse(raw) : {};
      s.apiKey = ${JSON.stringify(API_KEY)};
      s.model = ${JSON.stringify(MODEL)};
      s.stream = true;
      localStorage.setItem("sand2api.state.v1", JSON.stringify(s));
      return true;
    })()`);
    await cdp.send("Page.reload");
    await cdp.waitFor("document.readyState === 'complete'", { timeoutMs: 20000, label: "reload" });
    await sleep(700);
    // The 401 above was the point of that check, not a defect to carry forward.
    consoleErrors.length = 0;

    console.log("\nshell");
    check("title is set", (await cdp.eval("document.title")) === "cursor-sand2api");
    check("welcome screen is visible", await cdp.eval("!document.getElementById('welcome').hidden"));
    check("composer is present", await cdp.eval("Boolean(document.getElementById('input'))"));
    check(
      "no stylesheet fell back to unstyled",
      (await cdp.eval("getComputedStyle(document.body).backgroundColor")) !== "rgba(0, 0, 0, 0)"
    );

    console.log("\nhealth + models");
    await cdp.waitFor("!document.getElementById('health-dot').classList.contains('bad') || document.getElementById('health-text').textContent !== '连接中…'", {
      timeoutMs: 15000,
      label: "health probe",
    });
    const healthText = await cdp.eval("document.getElementById('health-text').textContent");
    check("health reports ok", /ok/.test(healthText), healthText);
    await cdp.waitFor("document.getElementById('model-name').textContent !== '加载模型…'", {
      timeoutMs: 20000,
      label: "model list",
    });
    const modelName = await cdp.eval("document.getElementById('model-name').textContent");
    check("model picker shows the saved model", modelName === MODEL, modelName);
    await cdp.shot("01-welcome");

    console.log("\nmodel menu");
    await cdp.eval("document.getElementById('model-btn').click()");
    await sleep(350);
    const optionCount = await cdp.eval("document.querySelectorAll('.model-option').length");
    check("menu lists models", optionCount > 5, optionCount);
    check(
      "options carry catalog metadata",
      await cdp.eval("document.querySelectorAll('.model-option .tag').length > 0")
    );
    await cdp.shot("02-model-menu");
    await cdp.eval("document.getElementById('model-search').value = 'haiku'; document.getElementById('model-search').dispatchEvent(new Event('input'))");
    await sleep(250);
    const filtered = await cdp.eval("document.querySelectorAll('.model-option').length");
    check("search filters the list", filtered > 0 && filtered < optionCount, { filtered, optionCount });
    await cdp.eval("document.dispatchEvent(new MouseEvent('click', {bubbles:true}))");
    await sleep(200);

    console.log("\nmarkdown rendering (offline, no model needed)");
    const mdHtml = await cdp.eval(
      `window.md.render("# T\\n\\nsome **bold** and \`code\`\\n\\n\`\`\`js\\nconst a = 1;\\n\`\`\`\\n\\n- one\\n- two\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |")`
    );
    check("renders headings", /<h1>T<\/h1>/.test(mdHtml));
    check("renders bold and inline code", /<strong>bold<\/strong>/.test(mdHtml) && /<code>code<\/code>/.test(mdHtml));
    check("renders fenced code with a copy button", /class="code-block"/.test(mdHtml) && /data-copy/.test(mdHtml));
    check("renders lists and tables", /<ul>/.test(mdHtml) && /<table>/.test(mdHtml));
    const xss = await cdp.eval(`window.md.render("<img src=x onerror=alert(1)>\\n\\n[x](javascript:alert(1))")`);
    check("escapes raw html", !/<img src=x/.test(xss), xss.slice(0, 80));
    check("refuses javascript: links", !/href="javascript:/.test(xss), xss.slice(0, 120));

    console.log("\nsending a turn");
    await cdp.eval(`(() => {
      const input = document.getElementById('input');
      input.value = 'Reply with exactly: pong';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send').click();
      return true;
    })()`);
    check("stop button appears while generating", await cdp.eval("!document.getElementById('stop').hidden"));
    await cdp.waitFor("document.getElementById('stop').hidden", { timeoutMs: 120000, label: "turn to finish" });
    await sleep(500);

    const answer = await cdp.eval(
      "(document.querySelector('.msg.assistant .md')||{}).textContent || ''"
    );
    check("assistant answered", answer.trim().length > 0, answer.slice(0, 80));
    check("answer looks right", /pong/i.test(answer), answer.slice(0, 80));
    console.log(`       model said: ${JSON.stringify(answer.trim().slice(0, 60))}`);
    check("user turn is shown", await cdp.eval("Boolean(document.querySelector('.msg.user'))"));
    check("usage badge is filled", await cdp.eval("!document.getElementById('turn-usage').hidden"));
    const usage = await cdp.eval("document.getElementById('turn-usage').textContent");
    check("usage shows token counts", /\d+ in/.test(usage), usage);
    check("conversation was added to the sidebar", await cdp.eval("document.querySelectorAll('.conv').length >= 1"));
    check("conversation title came from the prompt", await cdp.eval("document.querySelector('.conv-title').textContent.length > 0"));
    await cdp.shot("03-conversation");

    console.log("\npersistence");
    await cdp.send("Page.reload");
    await cdp.waitFor("document.readyState === 'complete'", { timeoutMs: 20000, label: "reload" });
    await sleep(800);
    check("conversation survived a reload", await cdp.eval("document.querySelectorAll('.msg').length >= 2"));
    const restored = await cdp.eval("(document.querySelector('.msg.assistant .md')||{}).textContent || ''");
    check("answer survived a reload", /pong/i.test(restored), restored.slice(0, 60));

    console.log("\nlight theme");
    await cdp.eval("document.getElementById('toggle-theme').click()");
    await sleep(350);
    check("theme attribute flipped", (await cdp.eval("document.documentElement.dataset.theme")) === "light");
    const bg = await cdp.eval("getComputedStyle(document.body).backgroundColor");
    check("light background applied", bg === "rgb(255, 255, 255)", bg);
    await cdp.shot("04-light");
    await cdp.eval("document.getElementById('toggle-theme').click()");
    await sleep(250);

    console.log("\nparams panel");
    await cdp.eval("document.getElementById('toggle-params').click()");
    await sleep(250);
    check("params panel opens", await cdp.eval("!document.getElementById('params').hidden"));
    await cdp.shot("05-params");
    await cdp.eval("document.getElementById('toggle-params').click()");

    console.log("\nattachment staging");
    // Feeding the file input directly exercises the same path a drop does.
    await cdp.eval(`(async () => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const file = new File([bytes], "dot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`, { awaitPromise: true });
    await sleep(400);
    check("attachment chip appears", await cdp.eval("document.querySelectorAll('.attachment').length === 1"));
    check("image preview rendered", await cdp.eval("Boolean(document.querySelector('.attachment img'))"));
    await cdp.shot("06-attachment");
    await cdp.eval("document.querySelector('.attachment .remove').click()");
    await sleep(200);
    check("attachment can be removed", await cdp.eval("document.getElementById('attachments').hidden"));

    // The whole attachment path in one shot: canvas -> File -> data URL ->
    // /v1/chat/completions -> image-attach -> selectedImages -> the model.
    console.log("\nimage attachment end to end");
    {
      await cdp.eval("document.getElementById('new-chat').click()");
      await sleep(250);
      await cdp.eval(`(() => {
        const raw = localStorage.getItem("sand2api.state.v1");
        const s = JSON.parse(raw);
        s.model = ${JSON.stringify(VISION_MODEL)};
        localStorage.setItem("sand2api.state.v1", JSON.stringify(s));
        return true;
      })()`);
      await cdp.send("Page.reload");
      await cdp.waitFor("document.readyState === 'complete'", { timeoutMs: 20000, label: "reload" });
      await sleep(900);
      consoleErrors.length = 0;

      await cdp.eval(
        `(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 96; canvas.height = 96;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ff0000';
          ctx.fillRect(0, 0, 96, 96);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          const file = new File([blob], 'red.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.getElementById('file-input');
          input.files = dt.files;
          input.dispatchEvent(new Event('change'));
          await new Promise((r) => setTimeout(r, 500));
          const box = document.getElementById('input');
          box.value = 'What colour fills this image? Answer with one word.';
          box.dispatchEvent(new Event('input'));
          document.getElementById('send').click();
          return true;
        })()`,
        { awaitPromise: true }
      );
      await cdp.waitFor("document.getElementById('stop').hidden", { timeoutMs: 120000, label: "vision turn" });
      await sleep(500);
      const seen = await cdp.eval("(document.querySelector('.msg.assistant .md')||{}).textContent || ''");
      check("model received the image", /red/i.test(seen), seen.slice(0, 90));
      console.log(`       model said: ${JSON.stringify(seen.trim().slice(0, 60))}`);
      check("sent image is shown in the transcript", await cdp.eval("Boolean(document.querySelector('.msg.user img'))"));
      await cdp.shot("07-vision");
    }

    console.log("\nmarkdown from a real answer");
    {
      await cdp.eval("document.getElementById('new-chat').click()");
      await sleep(250);
      await cdp.eval(`(() => {
        const box = document.getElementById('input');
        box.value = 'Reply with a markdown fenced javascript code block containing exactly: const a = 1; Nothing else.';
        box.dispatchEvent(new Event('input'));
        document.getElementById('send').click();
        return true;
      })()`);
      await cdp.waitFor("document.getElementById('stop').hidden", { timeoutMs: 120000, label: "markdown turn" });
      await sleep(500);
      check("fenced code became a code block", await cdp.eval("Boolean(document.querySelector('.msg.assistant .code-block'))"));
      check("code block has a copy button", await cdp.eval("Boolean(document.querySelector('.msg.assistant .code-block [data-copy]'))"));
      await cdp.shot("08-markdown");
    }

    console.log("\nnew conversation");
    await cdp.eval("document.getElementById('new-chat').click()");
    await sleep(300);
    check("welcome returns on a fresh chat", await cdp.eval("!document.getElementById('welcome').hidden"));
    check("old conversation still listed", await cdp.eval("document.querySelectorAll('.conv').length >= 1"));

    console.log("\nconsole health");
    check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3));

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(`screenshots in ${path.relative(process.cwd(), SHOTS)}`);
  } finally {
    if (!process.env.KEEP) {
      try {
        child.kill();
      } catch {}
      await sleep(300);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {}
    } else {
      console.log(`\nKEEP set: browser still running on port ${PORT}, profile ${profile}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nui_smoke failed: ${e.message}`);
  process.exit(1);
});
