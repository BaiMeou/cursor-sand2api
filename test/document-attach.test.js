const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  collectDocuments,
  parseFileDataUrl,
  guessMimeFromName,
  documentPartInfo,
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_BYTES,
} = require("../src/document-attach");
const map = require("../src/openai-map");
const { buildTurnInput } = require("../src/history");

// A structurally real PDF: header, catalog, one empty page, trailer. Nothing in
// here opens it, but real bytes catch anything that mangles the base64 round
// trip the way a string of "A" would not.
function pdf() {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
    "latin1"
  );
}

function dataUrl(buf, mime = "application/pdf") {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 9 MB decoded: under the per-file cap, so three of them trip the per-turn one.
function bigDataUrl(mime = "application/pdf") {
  return `data:${mime};base64,${"A".repeat(12 * 1024 * 1024)}`;
}

describe("file data URLs", () => {
  it("decodes a base64 pdf", () => {
    const parsed = parseFileDataUrl(dataUrl(pdf()));
    assert.equal(parsed.mime, "application/pdf");
    assert.deepEqual(parsed.data, pdf());
  });

  it("takes any type, unlike the image parser", () => {
    assert.equal(parseFileDataUrl("data:text/plain;base64,aGk=").mime, "text/plain");
    assert.equal(parseFileDataUrl("data:text/csv,a%2Cb").data.toString(), "a,b");
  });

  it("leaves an undeclared mime empty so the filename can decide", () => {
    assert.equal(parseFileDataUrl("data:;base64,aGk=").mime, "");
    assert.equal(parseFileDataUrl("data:,hello").mime, "");
  });

  it("refuses anything that is not inline data", () => {
    assert.equal(parseFileDataUrl("https://example.com/spec.pdf"), null);
    assert.equal(parseFileDataUrl(""), null);
    assert.equal(parseFileDataUrl("data:application/pdf;base64,"), null);
  });
});

describe("guessMimeFromName", () => {
  it("knows the document types worth naming", () => {
    assert.equal(guessMimeFromName("spec.pdf"), "application/pdf");
    assert.equal(guessMimeFromName("notes.txt"), "text/plain");
    assert.equal(guessMimeFromName("readme.md"), "text/markdown");
    assert.equal(guessMimeFromName("rows.csv"), "text/csv");
    assert.equal(guessMimeFromName("a.json"), "application/json");
    assert.equal(guessMimeFromName("a.xml"), "application/xml");
    assert.equal(guessMimeFromName("a.html"), "text/html");
    assert.match(guessMimeFromName("a.docx"), /wordprocessingml/);
    assert.match(guessMimeFromName("a.xlsx"), /spreadsheetml/);
    assert.match(guessMimeFromName("a.pptx"), /presentationml/);
  });

  it("ignores case and falls back when it cannot tell", () => {
    assert.equal(guessMimeFromName("SPEC.PDF"), "application/pdf");
    assert.equal(guessMimeFromName("blob.zzz"), "application/octet-stream");
    assert.equal(guessMimeFromName("noextension"), "application/octet-stream");
    assert.equal(guessMimeFromName(""), "application/octet-stream");
    assert.equal(guessMimeFromName(undefined), "application/octet-stream");
  });
});

describe("documentPartInfo", () => {
  it("reads the chat-completions shape", () => {
    assert.deepEqual(
      documentPartInfo({ type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,AA==" } }),
      { url: "data:application/pdf;base64,AA==", filename: "spec.pdf", fileId: "" }
    );
  });

  it("reads the Responses shape, named or not", () => {
    assert.deepEqual(documentPartInfo({ type: "input_file", filename: "spec.pdf", file_data: "data:,x" }), {
      url: "data:,x",
      filename: "spec.pdf",
      fileId: "",
    });
    assert.deepEqual(documentPartInfo({ type: "input_file", file_data: "data:,x" }), {
      url: "data:,x",
      filename: "",
      fileId: "",
    });
  });

  it("reports a bare file id so the caller can be told it is unusable", () => {
    assert.deepEqual(documentPartInfo({ type: "file", file: { file_id: "file-abc" } }), {
      url: "",
      filename: "",
      fileId: "file-abc",
    });
  });

  it("returns null for anything that is not a usable file part", () => {
    assert.equal(documentPartInfo({ type: "text", text: "hi" }), null);
    assert.equal(documentPartInfo({ type: "image_url", image_url: { url: "data:,x" } }), null);
    assert.equal(documentPartInfo({ type: "file", file: { filename: "spec.pdf" } }), null);
    assert.equal(documentPartInfo("spec.pdf"), null);
    assert.equal(documentPartInfo(null), null);
  });
});

describe("collectDocuments", () => {
  it("turns a file part into the attachment shape the protocol expects", () => {
    const { attachments, skipped } = collectDocuments([
      { type: "text", text: "summarise this" },
      { type: "file", file: { filename: "spec.pdf", file_data: dataUrl(pdf()) } },
    ]);
    assert.equal(skipped.length, 0);
    assert.equal(attachments.length, 1);
    const a = attachments[0];
    assert.equal(a.filename, "spec.pdf");
    assert.equal(a.path, "spec.pdf");
    assert.equal(a.mimeType, "application/pdf");
    assert.match(a.uuid, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(a), ["data", "uuid", "filename", "mimeType", "path"]);
  });

  it("carries the bytes through base64 untouched", () => {
    const { attachments } = collectDocuments([
      { type: "file", file: { filename: "spec.pdf", file_data: dataUrl(pdf()) } },
    ]);
    const back = Buffer.from(attachments[0].data, "base64");
    assert.deepEqual(back, pdf());
    assert.equal(back.toString("latin1", 0, 5), "%PDF-");
  });

  it("accepts the Responses spelling", () => {
    const { attachments } = collectDocuments([
      { type: "input_file", filename: "spec.pdf", file_data: dataUrl(pdf()) },
    ]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, "spec.pdf");
  });

  it("names an unnamed document after its type", () => {
    const { attachments } = collectDocuments([
      { type: "input_file", file_data: dataUrl(pdf()) },
      { type: "input_file", file_data: "data:text/csv;base64,YSxi" },
    ]);
    assert.equal(attachments[0].filename, "document-1.pdf");
    assert.equal(attachments[0].path, "document-1.pdf");
    assert.equal(attachments[1].filename, "document-2.csv");
  });

  it("guesses the mime from the filename when the data URL omits it", () => {
    const { attachments } = collectDocuments([
      { type: "input_file", filename: "notes.md", file_data: "data:;base64,aGk=" },
    ]);
    assert.equal(attachments[0].mimeType, "text/markdown");
  });

  it("lets a known extension beat a caller's octet-stream", () => {
    const { attachments } = collectDocuments([
      { type: "file", file: { filename: "spec.pdf", file_data: dataUrl(pdf(), "application/octet-stream") } },
    ]);
    assert.equal(attachments[0].mimeType, "application/pdf");
  });

  it("falls back to octet-stream when neither side says anything", () => {
    const { attachments } = collectDocuments([{ type: "input_file", file_data: "data:;base64,aGk=" }]);
    assert.equal(attachments[0].mimeType, "application/octet-stream");
    assert.equal(attachments[0].filename, "document-1.bin");
  });

  it("says a file id is unusable rather than pretending it attached", () => {
    const { attachments, skipped } = collectDocuments([{ type: "file", file: { file_id: "file-abc" } }]);
    assert.equal(attachments.length, 0);
    assert.deepEqual(skipped, ["[document by id file-abc is not supported]"]);
  });

  it("reports a remote url rather than silently fetching it", () => {
    const { attachments, skipped } = collectDocuments([
      { type: "file", file: { filename: "spec.pdf", file_data: "https://example.com/spec.pdf" } },
    ]);
    assert.equal(attachments.length, 0);
    assert.match(skipped[0], /document at https:\/\/example\.com\/spec\.pdf/);
  });

  it("refuses an oversized document instead of blowing up the frame", () => {
    const huge = `data:application/pdf;base64,${"A".repeat(16 * 1024 * 1024)}`;
    const { attachments, skipped } = collectDocuments([{ type: "input_file", filename: "big.pdf", file_data: huge }]);
    assert.equal(attachments.length, 0);
    assert.match(skipped[0], /too large/);
  });

  it("stops once the turn's total budget is spent", () => {
    const { attachments, skipped } = collectDocuments([
      { type: "input_file", filename: "a.pdf", file_data: bigDataUrl() },
      { type: "input_file", filename: "b.pdf", file_data: bigDataUrl() },
      { type: "input_file", filename: "c.pdf", file_data: bigDataUrl() },
    ]);
    assert.equal(attachments.length, 2);
    assert.deepEqual(attachments.map((a) => a.filename), ["a.pdf", "b.pdf"]);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /too large/);
  });

  it("keeps several documents in order", () => {
    const { attachments } = collectDocuments([
      { type: "file", file: { filename: "one.pdf", file_data: dataUrl(pdf()) } },
      { type: "text", text: "and" },
      { type: "input_file", filename: "two.csv", file_data: "data:text/csv;base64,YSxi" },
      { type: "file", file: { filename: "three.txt", file_data: "data:text/plain;base64,aGk=" } },
    ]);
    assert.deepEqual(attachments.map((a) => a.filename), ["one.pdf", "two.csv", "three.txt"]);
    assert.deepEqual(attachments.map((a) => a.mimeType), ["application/pdf", "text/csv", "text/plain"]);
  });

  it("gives every document its own uuid", () => {
    const { attachments } = collectDocuments([
      { type: "input_file", filename: "a.pdf", file_data: dataUrl(pdf()) },
      { type: "input_file", filename: "b.pdf", file_data: dataUrl(pdf()) },
    ]);
    assert.notEqual(attachments[0].uuid, attachments[1].uuid);
  });

  it("finds nothing in plain text", () => {
    assert.deepEqual(collectDocuments("hello"), { attachments: [], skipped: [] });
    assert.deepEqual(collectDocuments(undefined), { attachments: [], skipped: [] });
    assert.deepEqual(collectDocuments([{ type: "text", text: "hi" }]), { attachments: [], skipped: [] });
  });

  it("keeps the per-turn budget above the per-file one", () => {
    assert.ok(MAX_DOCUMENT_BYTES < MAX_TOTAL_BYTES);
  });
});

describe("prompt text around an attached document", () => {
  const withDoc = [
    {
      role: "user",
      content: [
        { type: "text", text: "summarise" },
        { type: "input_file", filename: "spec.pdf", file_data: dataUrl(pdf()) },
      ],
    },
  ];

  it("stops claiming the file was omitted once it is really attached", () => {
    const prompt = map.messagesToPrompt(withDoc, "", { documentsAttached: true });
    assert.match(prompt, /summarise/);
    assert.doesNotMatch(prompt, /file omitted/);
  });

  it("still says so when nothing was attached", () => {
    assert.match(map.messagesToPrompt(withDoc, ""), /file omitted: spec\.pdf/);
  });

  it("reads the filename off the chat-completions nesting too", () => {
    const nested = [
      { role: "user", content: [{ type: "file", file: { filename: "report.csv" } }] },
    ];
    assert.match(map.messagesToPrompt(nested, ""), /file omitted: report\.csv/);
  });

  it("only the last user turn counts as attached", () => {
    const prompt = map.messagesToPrompt(
      [...withDoc, { role: "assistant", content: "ok" }, { role: "user", content: "and now?" }],
      "",
      { documentsAttached: true }
    );
    // The earlier turn's document did not travel, so it keeps its placeholder.
    assert.match(prompt, /file omitted: spec\.pdf/);
  });

  // The two kinds ride the same turn but are collected independently, so one
  // being attached must not silence the other's placeholder.
  it("suppresses each placeholder only for the kind actually sent", () => {
    const both = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "input_file", filename: "spec.pdf", file_data: dataUrl(pdf()) },
        ],
      },
    ];
    const docsOnly = map.messagesToPrompt(both, "", { documentsAttached: true });
    assert.match(docsOnly, /image omitted/);
    assert.doesNotMatch(docsOnly, /file omitted/);

    const imagesOnly = map.messagesToPrompt(both, "", { imagesAttached: true });
    assert.match(imagesOnly, /file omitted/);
    assert.doesNotMatch(imagesOnly, /image omitted/);
  });
});

describe("history turn input around an attachment", () => {
  const active = [
    {
      role: "user",
      content: [
        { type: "text", text: "summarise" },
        { type: "input_file", filename: "spec.pdf", file_data: dataUrl(pdf()) },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ];

  it("drops both placeholders from the active turn when both are attached", () => {
    const { userText } = buildTurnInput(active, { imagesAttached: true, documentsAttached: true });
    assert.match(userText, /summarise/);
    assert.doesNotMatch(userText, /omitted/);
  });

  it("keeps the placeholders when nothing is attached", () => {
    const { userText } = buildTurnInput(active);
    assert.match(userText, /image omitted/);
    assert.match(userText, /file omitted: spec\.pdf/);
  });

  it("keeps history data-URLs as structured parts", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { rootMessages, userText } = buildTurnInput(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "summarise" },
            { type: "input_file", filename: "spec.pdf", file_data: dataUrl(pdf()) },
            { type: "image_url", image_url: { url: png } },
          ],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
      { imagesAttached: true, documentsAttached: true }
    );
    assert.equal(userText, "and now?");
    const past = rootMessages.find((m) => m.role === "user");
    assert.equal(past.content[0].text, "summarise");
    assert.equal(past.content.some((p) => p.type === "file" && p.filename === "spec.pdf"), true);
    assert.equal(past.content.some((p) => p.type === "image"), true);
    assert.doesNotMatch(past.content.map((p) => p.text || "").join(""), /omitted/);
  });
});
