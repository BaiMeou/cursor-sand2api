// Images ride the current turn as userMessage.selectedContext.selectedImages.
// Verified 2026-08-30 against api2.cursor.sh with client-type sand: a solid-red
// PNG attached this way came back correctly described by claude-4.5-haiku and
// gpt-5-mini, while the same question without the attachment answered NOIMAGE.
//
// Dimensions are read out of the file header rather than left at zero, because
// some models drop a 0x0 attachment.

const { randomUUID } = require("crypto");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const DATA_URL = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s;

function parseDataUrl(url) {
  const match = DATA_URL.exec(String(url || ""));
  if (!match) return null;
  const mime = (match[1] || "image/png").trim().toLowerCase();
  if (!mime.startsWith("image/")) return null;
  const isBase64 = /;base64/i.test(match[2] || "");
  try {
    const data = isBase64
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return data.length ? { data, mime } : null;
  } catch {
    return null;
  }
}

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1];
    // Start-of-frame markers carry the size; C4/C8/CC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    at += 2 + b.readUInt16BE(at + 2);
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (kind === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

function imageSize(data) {
  for (const reader of [pngSize, jpegSize, gifSize, webpSize]) {
    try {
      const size = reader(data);
      if (size && size.width > 0 && size.height > 0) return size;
    } catch {}
  }
  return null;
}

function imagePartUrl(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "image_url") {
    const src = part.image_url;
    return typeof src === "string" ? src : (src && src.url) || "";
  }
  if (part.type === "input_image") {
    return part.image_url || part.image || "";
  }
  return "";
}

// Only the active turn can carry attachments, so history images stay as text.
function collectImages(content) {
  const attachments = [];
  const skipped = [];
  if (!Array.isArray(content)) return { attachments, skipped };

  let total = 0;
  for (const part of content) {
    const url = imagePartUrl(part);
    if (!url) continue;
    const parsed = parseDataUrl(url);
    if (!parsed) {
      // A remote URL would have to be fetched, which this proxy will not do on
      // a caller's behalf; the model at least learns one was referenced.
      skipped.push(/^https?:/i.test(url) ? `[image at ${url}]` : "[image dropped: unreadable source]");
      continue;
    }
    if (parsed.data.length > MAX_IMAGE_BYTES || total + parsed.data.length > MAX_TOTAL_BYTES) {
      skipped.push("[image dropped: too large]");
      continue;
    }
    total += parsed.data.length;
    const size = imageSize(parsed.data) || { width: 1024, height: 1024 };
    attachments.push({
      data: parsed.data.toString("base64"),
      uuid: randomUUID(),
      path: `attachment-${attachments.length + 1}.${parsed.mime.split("/").pop()}`,
      dimension: { width: size.width, height: size.height },
      mimeType: parsed.mime,
    });
  }
  return { attachments, skipped };
}

module.exports = { collectImages, parseDataUrl, imageSize, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
