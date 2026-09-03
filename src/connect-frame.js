const zlib = require("zlib");

const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;

function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.alloc(5 + json.length);
  frame[0] = 0;
  frame.writeUInt32BE(json.length, 1);
  json.copy(frame, 5);
  return frame;
}

function decodeTrailer(text) {
  const raw = String(text || "").trim();
  if (!raw) return { kind: "trailer", error: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error) {
      const code = parsed.error.code || "error";
      const message = parsed.error.message || raw;
      return { kind: "trailer", error: `${code}: ${message}`, trailer: parsed };
    }
    return { kind: "trailer", error: null, trailer: parsed };
  } catch {
    return { kind: "trailer", error: raw.slice(0, 500) };
  }
}

// Connect envelopes straddle HTTP/2 DATA chunks, so leftovers stay buffered
// until the next push. Flags matter: 0x01 payloads are gzip, and 0x02 is the
// end-of-stream trailer that can carry an error behind an HTTP 200.
function createFrameReader() {
  let buffer = Buffer.alloc(0);

  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    const frames = [];
    let offset = 0;

    while (offset + 5 <= buffer.length) {
      const flags = buffer[offset];
      const len = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + len > buffer.length) break;
      let payload = buffer.subarray(offset + 5, offset + 5 + len);
      offset += 5 + len;

      if (flags & FLAG_COMPRESSED) {
        try {
          payload = zlib.gunzipSync(payload);
        } catch (e) {
          frames.push({ kind: "invalid", error: `gunzip failed: ${e.message}` });
          continue;
        }
      }

      const text = payload.toString("utf8");
      if (flags & FLAG_END_STREAM) {
        frames.push(decodeTrailer(text));
        continue;
      }
      try {
        frames.push({ kind: "message", message: JSON.parse(text) });
      } catch {
        frames.push({ kind: "invalid", error: `not JSON: ${text.slice(0, 200)}` });
      }
    }

    buffer = offset ? buffer.subarray(offset) : buffer;
    return frames;
  };
}

module.exports = { encodeFrame, createFrameReader, decodeTrailer, FLAG_COMPRESSED, FLAG_END_STREAM };
