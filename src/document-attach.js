// Documents ride the current turn as userMessage.selectedContext.selectedDocuments
// (field 25), the sibling of selectedImages (field 1). Encoding matches images:
// under connect+json the bytes field is a plain base64 string.
//
// SelectedDocument numbers its fields differently from SelectedImage
// (3 filename / 4 mimeType / 7 path, against the image's 3 path / 7 mimeType),
// which only bites if this ever moves to binary protobuf; the JSON key names are
// what travels today.
//
// There is no header to sniff the way images carry their dimensions, so the mime
// is layered: what the data URL declares, then the filename's extension, then a
// generic fallback.

const { randomUUID } = require("crypto");

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DATA_URL = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s;
const DEFAULT_MIME = "application/octet-stream";

const MIME_BY_EXT = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function parseFileDataUrl(url) {
  const match = DATA_URL.exec(String(url || ""));
  if (!match) return null;
  // No type is enforced here: a document is whatever the caller says it is. An
  // absent mime stays empty rather than taking the RFC 2397 text/plain default,
  // so the filename still gets a say before the generic fallback.
  const mime = (match[1] || "").trim().toLowerCase();
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

function guessMimeFromName(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || DEFAULT_MIME;
}

// A nameless document still needs a name, and the mime is the only hint left.
function extFromMime(mime) {
  for (const ext of Object.keys(MIME_BY_EXT)) {
    if (MIME_BY_EXT[ext] === mime) return ext;
  }
  const subtype = String(mime).split("/").pop().split("+").pop().replace(/[^a-z0-9]/gi, "").toLowerCase();
  return subtype && subtype !== "octetstream" ? subtype : "bin";
}

function documentPartInfo(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type !== "file" && part.type !== "input_file") return null;
  // Chat-completions nests the payload under `file`; the Responses spelling puts
  // the same keys straight on the part.
  const src = part.file && typeof part.file === "object" ? part.file : part;
  const url = typeof src.file_data === "string" ? src.file_data.trim() : "";
  const filename = typeof src.filename === "string" ? src.filename.trim() : "";
  const fileId = typeof src.file_id === "string" ? src.file_id.trim() : "";
  if (!url && !fileId) return null;
  return { url, filename, fileId };
}

// Only the active turn can carry attachments, so history documents stay as text.
function collectDocuments(content) {
  const attachments = [];
  const skipped = [];
  if (!Array.isArray(content)) return { attachments, skipped };

  let total = 0;
  for (const part of content) {
    const info = documentPartInfo(part);
    if (!info) continue;
    if (!info.url) {
      // There is no file store behind this proxy to resolve an id against.
      skipped.push(`[document by id ${info.fileId} is not supported]`);
      continue;
    }
    const parsed = parseFileDataUrl(info.url);
    if (!parsed) {
      // A remote URL would have to be fetched, which this proxy will not do on
      // a caller's behalf; the model at least learns one was referenced.
      skipped.push(
        /^https?:/i.test(info.url) ? `[document at ${info.url}]` : "[document dropped: unreadable source]"
      );
      continue;
    }
    if (parsed.data.length > MAX_DOCUMENT_BYTES || total + parsed.data.length > MAX_TOTAL_BYTES) {
      skipped.push("[document dropped: too large]");
      continue;
    }
    total += parsed.data.length;
    // Callers that do not know the type send octet-stream, so a known extension
    // beats it rather than shipping a PDF as anonymous bytes.
    const declared = parsed.mime && parsed.mime !== DEFAULT_MIME ? parsed.mime : "";
    const mimeType = declared || guessMimeFromName(info.filename);
    const filename = info.filename || `document-${attachments.length + 1}.${extFromMime(mimeType)}`;
    attachments.push({
      data: parsed.data.toString("base64"),
      uuid: randomUUID(),
      filename,
      mimeType,
      // Nothing on this side has a real path; the filename is what the model
      // sees quoted back, so the two stay in sync.
      path: filename,
    });
  }
  return { attachments, skipped };
}

module.exports = {
  collectDocuments,
  parseFileDataUrl,
  guessMimeFromName,
  documentPartInfo,
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_BYTES,
};
