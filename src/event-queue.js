// A single-consumer handoff between the HTTP/2 reader and whoever is awaiting
// the next turn event.
//
// The reader emits whenever the upstream says something; the consumer only
// awaits between turns. Resolving a promise that nobody holds silently discards
// the event, which is how a second parallel tool call — arriving one flush after
// the first — used to vanish, leaving the upstream blocked on a result the
// caller was never asked for. Queueing costs nothing and cannot lose one.

function createEventQueue() {
  const pending = [];
  let waiting = null;

  return {
    emit(event) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(event);
        return;
      }
      pending.push(event);
    },
    next() {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    size() {
      return pending.length;
    },
  };
}

module.exports = { createEventQueue };
