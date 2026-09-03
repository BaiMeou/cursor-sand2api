const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const config = require("./config");

const MAX_READ = 1024 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const MAX_FETCH = 1024 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_LS_ENTRIES = 400;

function toolsEnabled() {
  return config.tools.mode === "workspace";
}

function shellEnabled() {
  return toolsEnabled() && config.tools.shell;
}

function fetchEnabled() {
  return toolsEnabled() && config.tools.fetch;
}

function workspaceRoot() {
  return path.resolve(config.tools.workspaceDir);
}

function ensureWorkspace() {
  const root = workspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function jailError(message) {
  const err = new Error(message);
  err.code = "JAIL";
  return err;
}

function resolveInWorkspace(input) {
  const root = workspaceRoot();
  let abs;
  if (!input || input === ".") abs = root;
  else if (path.isAbsolute(input)) abs = path.resolve(input);
  else abs = path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw jailError(`path outside workspace: ${input}`);
  }
  return abs;
}

function globToRegExp(glob) {
  const s = String(glob || "*")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, "[^/\\\\]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${s}$`, "i");
}

async function walkFiles(dir, acc, limit) {
  if (acc.length >= limit) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (acc.length >= limit) return;
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(p, acc, limit);
    else acc.push(p);
  }
}

async function doRead(args) {
  const abs = resolveInWorkspace(args.path);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { fileNotFound: { path: abs } };
  }
  if (!st.isFile()) return { invalidFile: { path: abs } };
  if (st.size > MAX_READ) {
    return { error: { error: `file too large (${st.size} bytes)` } };
  }
  const raw = await fsp.readFile(abs, "utf8");
  const lines = raw.split(/\r?\n/);
  const offset = Math.max(0, (args.offset || 1) - 1);
  const limit = args.limit ? Math.min(args.limit, lines.length - offset) : lines.length - offset;
  const slice = lines.slice(offset, offset + limit);
  const content = slice.join("\n");
  return {
    success: {
      path: abs,
      content,
      totalLines: lines.length,
      fileSize: String(st.size),
      truncated: offset + limit < lines.length,
      rangeApplied: Boolean(args.offset || args.limit),
    },
  };
}

async function doLs(args) {
  const abs = resolveInWorkspace(args.path || ".");
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { error: { path: abs, error: "not found" } };
  }
  if (!st.isDirectory()) return { error: { path: abs, error: "not a directory" } };

  async function node(dir, depth) {
    const childrenDirs = [];
    const childrenFiles = [];
    let numFiles = 0;
    const extCounts = {};
    if (depth < 0) {
      return {
        absPath: dir,
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: false,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      };
    }
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return {
        absPath: dir,
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: false,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      };
    }
    let n = 0;
    for (const ent of entries) {
      if (n >= MAX_LS_ENTRIES) break;
      n += 1;
      if (ent.isDirectory()) {
        childrenDirs.push(await node(path.join(dir, ent.name), depth - 1));
      } else {
        childrenFiles.push({ name: ent.name });
        numFiles += 1;
        const ext = path.extname(ent.name).replace(/^\./, "") || "(none)";
        extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
    return {
      absPath: dir,
      childrenDirs,
      childrenFiles,
      childrenWereProcessed: true,
      fullSubtreeExtensionCounts: extCounts,
      numFiles,
    };
  }

  return { success: { directoryTreeRoot: await node(abs, 2) } };
}

async function doGrep(args) {
  const root = resolveInWorkspace(args.path || ".");
  let pattern;
  try {
    pattern = new RegExp(args.pattern, args.caseInsensitive ? "i" : "");
  } catch (e) {
    return { error: { error: `bad pattern: ${e.message}` } };
  }
  const glob = args.glob ? globToRegExp(args.glob) : null;
  const files = [];
  const st = await fsp.stat(root).catch(() => null);
  if (!st) return { error: { error: "path not found" } };
  if (st.isFile()) files.push(root);
  else await walkFiles(root, files, 2000);

  const fileMatches = [];
  let totalMatchedLines = 0;
  const head = args.headLimit || MAX_GREP_MATCHES;

  for (const file of files) {
    if (totalMatchedLines >= head) break;
    if (glob && !glob.test(path.basename(file)) && !glob.test(file.replace(/\\/g, "/"))) continue;
    let text;
    try {
      const s = await fsp.stat(file);
      if (s.size > MAX_READ) continue;
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const matches = [];
    lines.forEach((line, i) => {
      if (totalMatchedLines >= head) return;
      if (pattern.test(line)) {
        matches.push({
          lineNumber: i + 1,
          content: line.slice(0, 500),
          contentTruncated: line.length > 500,
          isContextLine: false,
        });
        totalMatchedLines += 1;
      }
    });
    if (matches.length) {
      fileMatches.push({ file, matches });
    }
  }

  const mode = args.outputMode || "content";
  const ws = workspaceRoot();
  let union;
  if (mode === "files_with_matches" || mode === "files") {
    union = {
      files: {
        files: fileMatches.map((f) => f.file),
        totalFiles: fileMatches.length,
        clientTruncated: false,
        ripgrepTruncated: false,
      },
    };
  } else if (mode === "count") {
    union = {
      count: {
        counts: fileMatches.map((f) => ({ file: f.file, count: f.matches.length })),
        totalFiles: fileMatches.length,
        totalMatches: totalMatchedLines,
        clientTruncated: false,
        ripgrepTruncated: false,
      },
    };
  } else {
    union = {
      content: {
        matches: fileMatches,
        totalLines: totalMatchedLines,
        totalMatchedLines,
        clientTruncated: totalMatchedLines >= head,
        ripgrepTruncated: false,
      },
    };
  }

  return {
    success: {
      pattern: args.pattern,
      path: root,
      outputMode: mode,
      workspaceResults: { [ws]: union },
    },
  };
}

async function doWrite(args) {
  const abs = resolveInWorkspace(args.path);
  let body = args.fileText;
  if (body == null && args.fileBytes) {
    body = Buffer.from(args.fileBytes, "base64").toString("utf8");
  }
  if (body == null) return { error: { error: "empty write" } };
  if (Buffer.byteLength(body) > MAX_WRITE) return { error: { error: "write too large" } };
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, "utf8");
  const st = await fsp.stat(abs);
  const lines = body.split(/\r?\n/).length;
  const success = {
    path: abs,
    linesCreated: lines,
    fileSize: st.size,
  };
  if (args.returnFileContentAfterWrite) success.fileContentAfterWrite = body;
  return { success };
}

async function doDelete(args) {
  const abs = resolveInWorkspace(args.path);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { fileNotFound: { path: abs } };
  }
  if (!st.isFile()) return { notFile: { path: abs, actualType: "directory" } };
  await fsp.unlink(abs);
  return {
    success: {
      path: abs,
      deletedFile: abs,
      fileSize: String(st.size),
      prevContent: "",
    },
  };
}

function dangerousShell(cmd) {
  const s = String(cmd || "").toLowerCase();
  const banned = [
    "mkfs",
    "format ",
    "shutdown",
    "reboot",
    ":(){",
    "rm -rf /",
    "rm -rf /*",
    "del /s /q c:",
    "diskpart",
    "reg delete",
  ];
  return banned.some((b) => s.includes(b));
}

function runShell(args) {
  const cmd = args.command || (args.simpleCommands || []).join(" && ");
  if (!cmd) {
    return Promise.resolve({ failure: { command: "", workingDirectory: "", exitCode: 1, stdout: "", stderr: "empty command", executionTime: 0, aborted: false } });
  }
  if (dangerousShell(cmd)) {
    return Promise.resolve({ rejected: { reason: "command blocked by proxy denylist" } });
  }
  const cwd = (() => {
    try {
      return resolveInWorkspace(args.workingDirectory || ".");
    } catch {
      return workspaceRoot();
    }
  })();
  const rawTimeout = args.hardTimeout || args.timeout || 30000;
  const timeoutMs = Math.min(Math.max(rawTimeout > 500 ? rawTimeout : rawTimeout * 1000, 1000), config.tools.shellTimeoutMs);
  const isWin = process.platform === "win32";
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
  const shellArgs = isWin ? ["/d", "/s", "/c", cmd] : ["-lc", cmd];
  const t0 = Date.now();

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PWD: cwd },
    });
    let stdout = "";
    let stderr = "";
    const cap = 200000;
    child.stdout.on("data", (b) => {
      if (stdout.length < cap) stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < cap) stderr += b.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({
        timeout: {
          command: cmd,
          workingDirectory: cwd,
          exitCode: -1,
          stdout: stdout.slice(0, cap),
          stderr: stderr.slice(0, cap) + "\n[timeout]",
          executionTime: Date.now() - t0,
          aborted: true,
        },
      });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ spawnError: { error: e.message } });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        success: {
          command: cmd,
          workingDirectory: cwd,
          exitCode: code || 0,
          signal: signal || "",
          stdout: stdout.slice(0, cap),
          stderr: stderr.slice(0, cap),
          executionTime: Date.now() - t0,
          pid: child.pid,
          localExecutionTimeMs: Date.now() - t0,
        },
      });
    });
  });
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "metadata.google.internal") return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1|fc|fd)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

async function doFetch(args) {
  const url = args.url;
  if (!url) return { error: { url: "", error: "missing url" } };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: { url, error: "bad url" } };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: { url, error: "only http/https" } };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { error: { url, error: "private host blocked" } };
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    const buf = Buffer.from(await res.arrayBuffer());
    const cut = buf.subarray(0, MAX_FETCH);
    const contentType = res.headers.get("content-type") || "";
    const content = cut.toString(contentType.includes("utf-16") ? "utf8" : "utf8");
    return {
      success: {
        url,
        content: content.slice(0, MAX_FETCH),
        statusCode: res.status,
        contentType,
      },
    };
  } catch (e) {
    return { error: { url, error: e.message } };
  } finally {
    clearTimeout(t);
  }
}

async function doGitDiff() {
  if (!shellEnabled()) {
    return { error: { error: "shell disabled" } };
  }
  const r = await runShell({ command: "git diff --stat && git diff", workingDirectory: ".", timeout: 15000 });
  if (r.success) {
    return { success: { diff: r.success.stdout || "" } };
  }
  return { error: { error: (r.failure || r.timeout || r.rejected || {}).reason || "git diff failed" } };
}

function requestContextPayload(workspaceOverride, mcpTools, webSearch) {
  const clientWs = workspaceOverride && String(workspaceOverride).trim();
  const localWs = config.tools.mode === "workspace" ? workspaceRoot() : "";
  const ws = clientWs || localWs;
  const env = {
    osVersion: `${os.platform()} ${os.release()}`,
    workspacePaths: ws ? [ws] : [],
    shell: process.platform === "win32" ? "powershell" : "bash",
    sandboxEnabled: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    projectFolder: ws || "",
    processWorkingDirectory: ws || process.cwd(),
    sandboxSupported: true,
    computerUseSupported: false,
    isWorkingDirHomeDir: false,
  };
  const payload = {
    env,
    webSearchEnabled: Boolean(webSearch),
    webFetchEnabled: webSearch ? true : config.tools.mode === "client" ? true : fetchEnabled(),
    gitRepoInfoComplete: true,
  };
  if (mcpTools && mcpTools.length) payload.tools = mcpTools;
  return payload;
}

module.exports = {
  toolsEnabled,
  shellEnabled,
  fetchEnabled,
  workspaceRoot,
  ensureWorkspace,
  resolveInWorkspace,
  doRead,
  doLs,
  doGrep,
  doWrite,
  doDelete,
  runShell,
  doFetch,
  doGitDiff,
  requestContextPayload,
};
