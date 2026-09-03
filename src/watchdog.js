// Two clocks, because a wedged turn looks different from a dead socket.
//
//   idle   — any inbound frame resets it, heartbeats included. Catches a
//            connection that stopped talking without closing.
//   output — only real model output (text or thinking) resets it. Catches the
//            stream that keeps exchanging control frames forever and never
//            answers; the idle clock alone never fires on that.
//
// Both stand down while the caller is running tool_calls: that stretch is
// caller-owned time, bounded by the session TTL in server.js.

function createWatchdogs({ idleMs, outputMs, onTrip, isParked = () => false }) {
  const timers = { idle: null, output: null };
  let stopped = false;

  function arm(key, ms, reason) {
    clearTimeout(timers[key]);
    timers[key] = null;
    if (stopped || !ms) return;
    timers[key] = setTimeout(() => {
      if (isParked()) return arm(key, ms, reason);
      stop();
      onTrip(reason);
    }, ms);
  }

  function touchIdle() {
    arm("idle", idleMs, `no upstream frame for ${idleMs}ms`);
  }

  function touchOutput() {
    arm("output", outputMs, `upstream produced no output for ${outputMs}ms`);
  }

  function stop() {
    stopped = true;
    clearTimeout(timers.idle);
    clearTimeout(timers.output);
    timers.idle = null;
    timers.output = null;
  }

  return {
    // Called once when the run request goes out, and again whenever tool
    // results are submitted and a fresh answer is expected.
    start() {
      stopped = false;
      touchIdle();
      touchOutput();
    },
    frame: touchIdle,
    output() {
      touchIdle();
      touchOutput();
    },
    stop,
  };
}

module.exports = { createWatchdogs };
