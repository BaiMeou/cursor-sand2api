const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createAgentScratch, isScratchPath, SCRATCH_PREFIX } = require("../src/agent-scratch");

describe("scratch ownership", () => {
  it("claims the prefix the agent writes its tool output to", () => {
    assert.equal(isScratchPath("agent-tools/abc.txt"), true);
    assert.equal(isScratchPath("/tmp/work/agent-tools/abc.txt"), true);
    assert.equal(isScratchPath("agent-tools\\abc.txt"), true);
  });

  it("claims nothing on the caller's machine", () => {
    assert.equal(isScratchPath("src/index.js"), false);
    assert.equal(isScratchPath("/etc/passwd"), false);
    assert.equal(isScratchPath(""), false);
  });

  it("keeps serving a file it already wrote, wherever it lives", () => {
    const s = createAgentScratch();
    assert.equal(s.owns("notes.txt"), false);
    s.write({ path: `${SCRATCH_PREFIX}notes.txt`, fileText: "x" });
    assert.equal(s.owns(`${SCRATCH_PREFIX}notes.txt`), true);
  });
});

describe("scratch round trip", () => {
  it("reads back exactly what the search wrote", () => {
    const s = createAgentScratch();
    const body = "Links:\n1. https://nodejs.org\n2. https://github.com/nodejs/node";
    const w = s.write({ path: "agent-tools/a.txt", fileText: body });
    assert.equal(w.success.path, "agent-tools/a.txt");
    assert.equal(w.success.linesCreated, 3);
    assert.equal(s.read({ path: "agent-tools/a.txt" }).success.content, body);
  });

  it("honours an offset and limit the way a real read does", () => {
    const s = createAgentScratch();
    s.write({ path: "agent-tools/a.txt", fileText: "l1\nl2\nl3\nl4" });
    const r = s.read({ path: "agent-tools/a.txt", offset: 2, limit: 2 });
    assert.equal(r.success.content, "l2\nl3");
    assert.equal(r.success.totalLines, 4);
    assert.equal(r.success.truncated, true);
  });

  it("reports a miss instead of inventing content", () => {
    assert.ok(createAgentScratch().read({ path: "agent-tools/missing.txt" }).fileNotFound);
  });

  it("accepts base64 bytes as well as text", () => {
    const s = createAgentScratch();
    s.write({ path: "agent-tools/b.txt", fileBytes: Buffer.from("hi").toString("base64") });
    assert.equal(s.read({ path: "agent-tools/b.txt" }).success.content, "hi");
  });

  it("overwrites without leaking the old size", () => {
    const s = createAgentScratch();
    s.write({ path: "agent-tools/c.txt", fileText: "a".repeat(1000) });
    s.write({ path: "agent-tools/c.txt", fileText: "b" });
    assert.equal(s.stats().files, 1);
    assert.equal(s.stats().bytes, 1);
  });

  it("refuses to grow without bound", () => {
    const s = createAgentScratch();
    const r = s.write({ path: "agent-tools/big.txt", fileText: "x".repeat(5 * 1024 * 1024) });
    assert.ok(r.error);
    assert.equal(s.stats().files, 0);
  });

  it("lists and deletes", () => {
    const s = createAgentScratch();
    s.write({ path: "agent-tools/a.txt", fileText: "1" });
    s.write({ path: "agent-tools/b.txt", fileText: "2" });
    assert.equal(s.list({ path: "agent-tools/" }).success.directoryTreeRoot.numFiles, 2);
    assert.ok(s.remove({ path: "agent-tools/a.txt" }).success);
    assert.ok(s.remove({ path: "agent-tools/a.txt" }).fileNotFound);
    assert.equal(s.stats().files, 1);
  });

  it("keeps two runs apart", () => {
    const a = createAgentScratch();
    const b = createAgentScratch();
    a.write({ path: "agent-tools/x.txt", fileText: "from a" });
    assert.ok(b.read({ path: "agent-tools/x.txt" }).fileNotFound);
  });
});
