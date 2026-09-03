const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createOutputLimiter, CHARS_PER_TOKEN } = require("../src/output-limit");

function drain(limiter, deltas) {
  let out = "";
  for (const d of deltas) out += limiter.push(d);
  out += limiter.flush();
  return out;
}

describe("output limiter", () => {
  it("passes everything through when nothing is configured", () => {
    const l = createOutputLimiter();
    assert.equal(drain(l, ["hello ", "world"]), "hello world");
    assert.equal(l.reason(), null);
    assert.equal(l.tripped(), false);
  });

  it("cuts at a stop sequence and reports it", () => {
    const l = createOutputLimiter({ stops: ["END"] });
    assert.equal(drain(l, ["keep this END drop this"]), "keep this ");
    assert.equal(l.reason(), "stop_sequence");
    assert.equal(l.stopSequence(), "END");
  });

  it("catches a stop sequence split across deltas", () => {
    const l = createOutputLimiter({ stops: ["<<END>>"] });
    // The tail that could still become the sequence is withheld, so no part of
    // it escapes before the match completes.
    const out = drain(l, ["answer ", "<<EN", "D>> trailing"]);
    assert.equal(out, "answer ");
    assert.equal(l.reason(), "stop_sequence");
  });

  it("releases a near-miss tail once it cannot match", () => {
    const l = createOutputLimiter({ stops: ["<<END>>"] });
    assert.equal(drain(l, ["a<<EN", "Q b"]), "a<<ENQ b");
    assert.equal(l.reason(), null);
  });

  it("honours the first of several stop sequences", () => {
    const l = createOutputLimiter({ stops: ["STOP", "HALT"] });
    assert.equal(drain(l, ["go HALT no STOP no"]), "go ");
    assert.equal(l.stopSequence(), "HALT");
  });

  it("truncates on the max_tokens budget and reports length", () => {
    const l = createOutputLimiter({ maxTokens: 2 });
    const out = drain(l, ["x".repeat(50)]);
    assert.equal(out.length, 2 * CHARS_PER_TOKEN);
    assert.equal(l.reason(), "length");
  });

  it("stays quiet once it has tripped", () => {
    const l = createOutputLimiter({ stops: ["END"] });
    l.push("a END b");
    assert.equal(l.push(" more"), "");
    assert.equal(l.flush(), "");
    assert.equal(l.text(), "a ");
  });

  it("never re-emits text it already released", () => {
    const l = createOutputLimiter({ stops: ["ZZ"] });
    const parts = ["one ", "two ", "three"];
    let seen = "";
    for (const p of parts) seen += l.push(p);
    seen += l.flush();
    assert.equal(seen, "one two three");
    assert.equal(l.text(), "one two three");
  });

  it("ignores empty and non-string stop entries", () => {
    const l = createOutputLimiter({ stops: ["", null, undefined, 7] });
    assert.equal(drain(l, ["plain text"]), "plain text");
    assert.equal(l.reason(), null);
  });
});
