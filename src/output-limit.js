// Cursor honours neither max_tokens nor stop, so both are enforced here.
//
// A stop sequence can straddle two deltas, and streamed text cannot be recalled,
// so the tail that could still turn into a stop sequence is held back until the
// next delta proves it did not. Without that hold-back a sequence split across
// chunks reaches the caller before it is recognised.
//
// There is no tokenizer on this path; max_tokens is applied as a character
// budget, which is why the cap is deliberately generous rather than exact.

const CHARS_PER_TOKEN = 4;

function createOutputLimiter({ maxTokens = 0, stops = [] } = {}) {
  const sequences = (stops || []).filter((s) => typeof s === "string" && s);
  const holdBack = sequences.reduce((n, s) => Math.max(n, s.length - 1), 0);
  const cap = maxTokens > 0 ? maxTokens * CHARS_PER_TOKEN : 0;

  let kept = "";
  let released = 0;
  let reason = null;
  let matched = null;

  function emit(upTo) {
    const out = kept.slice(released, upTo);
    released = upTo;
    return out;
  }

  return {
    push(delta) {
      if (reason || !delta) return "";
      kept += delta;

      // Whichever sequence appears earliest in the output wins, not whichever
      // the caller happened to list first.
      let cut = -1;
      for (const s of sequences) {
        const at = kept.indexOf(s);
        if (at >= 0 && (cut < 0 || at < cut)) {
          cut = at;
          matched = s;
        }
      }
      if (cut >= 0) {
        reason = "stop_sequence";
        kept = kept.slice(0, cut);
        return emit(kept.length);
      }
      if (cap && kept.length > cap) {
        reason = "length";
        kept = kept.slice(0, cap);
        return emit(kept.length);
      }
      return emit(Math.max(released, kept.length - holdBack));
    },

    // Nothing more is coming, so the held-back tail can no longer complete a
    // stop sequence.
    flush() {
      if (reason) return "";
      return emit(kept.length);
    },

    reason: () => reason,
    stopSequence: () => matched,
    text: () => kept,
    tripped: () => reason !== null,
  };
}

module.exports = { createOutputLimiter, CHARS_PER_TOKEN };
