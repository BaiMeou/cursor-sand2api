const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { collectImages, parseDataUrl, imageSize } = require("../src/image-attach");
const map = require("../src/openai-map");

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function png(width, height) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function gif(width, height) {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function dataUrl(buf, mime = "image/png") {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

describe("data URLs", () => {
  it("decodes a base64 image", () => {
    const parsed = parseDataUrl(dataUrl(png(4, 4)));
    assert.equal(parsed.mime, "image/png");
    assert.ok(parsed.data.length > 0);
  });

  it("refuses anything that is not an image", () => {
    assert.equal(parseDataUrl("data:text/plain;base64,aGk="), null);
    assert.equal(parseDataUrl("https://example.com/a.png"), null);
    assert.equal(parseDataUrl(""), null);
    assert.equal(parseDataUrl("data:image/png;base64,"), null);
  });
});

describe("dimensions", () => {
  it("reads them out of the header, since a 0x0 attachment gets dropped", () => {
    assert.deepEqual(imageSize(png(64, 32)), { width: 64, height: 32 });
    assert.deepEqual(imageSize(gif(12, 7)), { width: 12, height: 7 });
  });

  it("returns null for something it cannot read", () => {
    assert.equal(imageSize(Buffer.from("not an image")), null);
  });
});

describe("collectImages", () => {
  it("turns image parts into the attachment shape the protocol expects", () => {
    const { attachments, skipped } = collectImages([
      { type: "text", text: "what colour" },
      { type: "image_url", image_url: { url: dataUrl(png(8, 4)) } },
    ]);
    assert.equal(skipped.length, 0);
    assert.equal(attachments.length, 1);
    const a = attachments[0];
    assert.equal(a.mimeType, "image/png");
    assert.deepEqual(a.dimension, { width: 8, height: 4 });
    assert.match(a.uuid, /^[0-9a-f-]{36}$/);
    assert.ok(a.path.endsWith(".png"));
    assert.equal(Buffer.from(a.data, "base64").length > 0, true);
  });

  it("accepts the Responses-API spelling and a bare url string", () => {
    assert.equal(collectImages([{ type: "input_image", image_url: dataUrl(png(2, 2)) }]).attachments.length, 1);
    assert.equal(collectImages([{ type: "image_url", image_url: dataUrl(png(2, 2)) }]).attachments.length, 1);
  });

  it("reports a remote url rather than silently fetching it", () => {
    const { attachments, skipped } = collectImages([
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
    ]);
    assert.equal(attachments.length, 0);
    assert.match(skipped[0], /image at https:\/\/example\.com\/cat\.png/);
  });

  it("refuses an oversized image instead of blowing up the frame", () => {
    const huge = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`;
    const { attachments, skipped } = collectImages([{ type: "image_url", image_url: { url: huge } }]);
    assert.equal(attachments.length, 0);
    assert.match(skipped[0], /too large/);
  });

  it("keeps several images in order", () => {
    const { attachments } = collectImages([
      { type: "image_url", image_url: { url: dataUrl(png(4, 4)) } },
      { type: "image_url", image_url: { url: dataUrl(gif(9, 3), "image/gif") } },
    ]);
    assert.equal(attachments.length, 2);
    assert.deepEqual(attachments[1].dimension, { width: 9, height: 3 });
    assert.equal(attachments[1].mimeType, "image/gif");
  });

  it("finds nothing in plain text", () => {
    assert.deepEqual(collectImages("hello"), { attachments: [], skipped: [] });
    assert.deepEqual(collectImages(undefined), { attachments: [], skipped: [] });
  });
});

describe("prompt text around an attachment", () => {
  const withImage = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: dataUrl(png(4, 4)) } }] },
  ];

  it("stops claiming the image was omitted once it is really attached", () => {
    const prompt = map.messagesToPrompt(withImage, "", { imagesAttached: true });
    assert.match(prompt, /look/);
    assert.doesNotMatch(prompt, /image omitted/);
  });

  it("still says so when nothing was attached", () => {
    assert.match(map.messagesToPrompt(withImage, ""), /image omitted/);
  });

  it("only the last user turn counts as attached", () => {
    const prompt = map.messagesToPrompt(
      [...withImage, { role: "assistant", content: "ok" }, { role: "user", content: "and now?" }],
      "",
      { imagesAttached: true }
    );
    // The earlier turn's image did not travel, so it keeps its placeholder.
    assert.match(prompt, /image omitted/);
  });
});
