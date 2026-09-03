const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { createWatchdogs } = require("../src/watchdog");

function setup({ idleMs = 1000, outputMs = 3000, parked = false } = {}) {
  const trips = [];
  const wd = createWatchdogs({
    idleMs,
    outputMs,
    isParked: () => parked,
    onTrip: (reason) => trips.push(reason),
  });
  return { wd, trips, park: (v) => (parked = v) };
}

describe("watchdogs", () => {
  it("trips on a silent socket", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup();
    wd.start();
    t.mock.timers.tick(999);
    assert.deepEqual(trips, []);
    t.mock.timers.tick(2);
    assert.equal(trips.length, 1);
    assert.match(trips[0], /no upstream frame/);
  });

  it("heartbeat frames keep the socket clock alive", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 1000, outputMs: 100000 });
    wd.start();
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(900);
      wd.frame();
    }
    assert.deepEqual(trips, []);
  });

  it("but frames alone do not hold off the output clock", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 1000, outputMs: 3000 });
    wd.start();
    // A stream that keeps exchanging control frames and never answers.
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(900);
      wd.frame();
    }
    assert.equal(trips.length, 1);
    assert.match(trips[0], /produced no output/);
  });

  it("model output resets both clocks", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 1000, outputMs: 3000 });
    wd.start();
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(900);
      wd.output();
    }
    assert.deepEqual(trips, []);
  });

  it("stands down while the caller is running tool_calls", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips, park } = setup({ idleMs: 1000, outputMs: 3000 });
    wd.start();
    park(true);
    t.mock.timers.tick(60000);
    assert.deepEqual(trips, []);
    park(false);
    t.mock.timers.tick(1001);
    assert.equal(trips.length, 1);
  });

  it("fires once, not once per clock", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 1000, outputMs: 1000 });
    wd.start();
    t.mock.timers.tick(10000);
    assert.equal(trips.length, 1);
  });

  it("stop() silences both clocks", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup();
    wd.start();
    wd.stop();
    t.mock.timers.tick(100000);
    assert.deepEqual(trips, []);
  });

  it("start() rearms after tool results come back", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 1000, outputMs: 3000 });
    wd.start();
    wd.stop();
    wd.start();
    t.mock.timers.tick(1001);
    assert.equal(trips.length, 1);
  });

  it("treats a zero timeout as disabled", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { wd, trips } = setup({ idleMs: 0, outputMs: 0 });
    wd.start();
    t.mock.timers.tick(100000);
    assert.deepEqual(trips, []);
  });
});
