const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createEventQueue } = require("../src/event-queue");

describe("event queue", () => {
  it("delivers to a consumer that is already waiting", async () => {
    const q = createEventQueue();
    const pending = q.next();
    q.emit({ type: "done" });
    assert.deepEqual(await pending, { type: "done" });
  });

  it("keeps an event emitted with nobody waiting", async () => {
    const q = createEventQueue();
    q.emit({ type: "tool_calls", n: 1 });
    assert.equal(q.size(), 1);
    assert.deepEqual(await q.next(), { type: "tool_calls", n: 1 });
    assert.equal(q.size(), 0);
  });

  it("keeps a second parallel tool call that lands after the first was consumed", async () => {
    const q = createEventQueue();
    // First call arrives and is handed to the caller.
    q.emit({ type: "tool_calls", id: "a" });
    assert.deepEqual(await q.next(), { type: "tool_calls", id: "a" });
    // The caller is off running the tool; the second call arrives meanwhile.
    q.emit({ type: "tool_calls", id: "b" });
    // It must still be there when the caller comes back.
    assert.deepEqual(await q.next(), { type: "tool_calls", id: "b" });
  });

  it("preserves order across a burst", async () => {
    const q = createEventQueue();
    for (const id of ["a", "b", "c"]) q.emit({ id });
    assert.deepEqual(
      [(await q.next()).id, (await q.next()).id, (await q.next()).id],
      ["a", "b", "c"]
    );
  });

  it("drains the backlog before parking a new waiter", async () => {
    const q = createEventQueue();
    q.emit({ id: "queued" });
    const first = await q.next();
    assert.equal(first.id, "queued");
    const parked = q.next();
    q.emit({ id: "live" });
    assert.equal((await parked).id, "live");
  });
});
