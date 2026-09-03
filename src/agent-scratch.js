// Cursor's own web search does not hand its results back over the wire: it
// writes them into the workspace under `agent-tools/<uuid>.txt` and has the
// model read them again. Verified 2026-08-30 — refusing that write leaves the
// turn hanging after `toolCallStarted`, and serving it from memory lets the
// same turn finish with a real, sourced answer.
//
// Only that one prefix is served. A write anywhere else is still the model
// trying to touch the caller's machine, which is not this proxy's to allow.

const SCRATCH_PREFIX = "agent-tools/";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isScratchPath(path) {
  const p = normalizePath(path);
  return p.startsWith(SCRATCH_PREFIX) || p.includes(`/${SCRATCH_PREFIX}`);
}

function createAgentScratch() {
  const files = new Map();
  let total = 0;

  return {
    owns(path) {
      const p = normalizePath(path);
      return isScratchPath(p) || files.has(p);
    },

    write(args) {
      const path = normalizePath(args.path);
      let body = args.fileText;
      if (body == null && args.fileBytes) {
        body = Buffer.from(args.fileBytes, "base64").toString("utf8");
      }
      body = String(body == null ? "" : body);
      const size = Buffer.byteLength(body);
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
        return { error: { error: "agent scratch space exhausted" } };
      }
      const previous = files.get(path);
      if (previous !== undefined) total -= Buffer.byteLength(previous);
      files.set(path, body);
      total += size;
      return {
        success: { path, linesCreated: body.split("\n").length, fileSize: size },
      };
    },

    read(args) {
      const path = normalizePath(args.path);
      const body = files.get(path);
      if (body === undefined) return { fileNotFound: { path } };
      const lines = body.split("\n");
      const offset = Math.max(0, (args.offset || 1) - 1);
      const limit = args.limit ? Math.min(args.limit, lines.length - offset) : lines.length - offset;
      const slice = lines.slice(offset, offset + limit).join("\n");
      return {
        success: {
          path,
          content: slice,
          totalLines: lines.length,
          fileSize: String(Buffer.byteLength(body)),
          truncated: offset + limit < lines.length,
          rangeApplied: Boolean(args.offset || args.limit),
        },
      };
    },

    list(args) {
      const root = normalizePath(args && args.path) || SCRATCH_PREFIX;
      const names = [...files.keys()].filter((p) => p.startsWith(root) || root === SCRATCH_PREFIX);
      return {
        success: {
          directoryTreeRoot: {
            absPath: root,
            childrenDirs: [],
            childrenFiles: names.map((name) => ({ name })),
            childrenWereProcessed: true,
            fullSubtreeExtensionCounts: {},
            numFiles: names.length,
          },
        },
      };
    },

    remove(args) {
      const path = normalizePath(args.path);
      const body = files.get(path);
      if (body === undefined) return { fileNotFound: { path } };
      files.delete(path);
      total -= Buffer.byteLength(body);
      return { success: { path, deletedFile: path, fileSize: String(Buffer.byteLength(body)), prevContent: "" } };
    },

    stats() {
      return { files: files.size, bytes: total };
    },
  };
}

module.exports = { createAgentScratch, isScratchPath, SCRATCH_PREFIX, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
