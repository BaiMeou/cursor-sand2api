#!/usr/bin/env node
// Pulls the credentials this proxy needs straight out of a locally installed
// Cursor, so nobody has to open a 180 MB SQLite file by hand.
//
// The three values live in two places: the access token in `state.vscdb`
// (an ItemTable key/value store), and the two machine ids in `storage.json`
// next to it. See docs/credentials.md and docs/advanced/reverse-engineering.md.
//
// Usage:
//   node scripts/import-cursor-token.js              # write ./token.json
//   node scripts/import-cursor-token.js --print      # show the account, write nothing
//   node scripts/import-cursor-token.js --name work --out other.json
//   node scripts/import-cursor-token.js --db "/path/to/state.vscdb"

const fs = require("fs");
const os = require("os");
const path = require("path");

// node:sqlite is still flagged experimental and prints a warning on first use.
// It is the only thing this script does, so the notice is noise.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning" || !/SQLite/i.test(w.message)) console.warn(w.stack || w.message);
});

const AUTH_KEYS = {
  accessToken: "cursorAuth/accessToken",
  refreshToken: "cursorAuth/refreshToken",
  email: "cursorAuth/cachedEmail",
  membership: "cursorAuth/stripeMembershipType",
};

function parseArgs(argv) {
  const args = { name: "", out: "", db: "", print: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print") args.print = true;
    else if (a === "--force") args.force = true;
    else if (a === "--name") args.name = argv[++i] || "";
    else if (a === "--out") args.out = argv[++i] || "";
    else if (a === "--db") args.db = argv[++i] || "";
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// Cursor keeps its profile where the host OS puts application data. A portable
// install can sit anywhere, hence --db.
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    dirs.push(path.join(appData, "Cursor"));
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "Cursor"));
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    dirs.push(path.join(configHome, "Cursor"));
    dirs.push(path.join(home, ".cursor"));
  }
  return dirs.map((d) => path.join(d, "User", "globalStorage")).filter((d) => fs.existsSync(d));
}

function locate(explicitDb) {
  if (explicitDb) {
    const dir = path.dirname(explicitDb);
    return { db: explicitDb, storage: path.join(dir, "storage.json") };
  }
  for (const dir of candidateDirs()) {
    const db = path.join(dir, "state.vscdb");
    if (fs.existsSync(db)) return { db, storage: path.join(dir, "storage.json") };
  }
  return null;
}

function openDatabase(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error(
      `this Node (${process.version}) has no node:sqlite — Node 22.5+ is required to read Cursor's credential store`
    );
  }
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), temp: null };
  } catch (e) {
    // A running Cursor holds the write lock and leaves a -wal alongside the
    // database. Reading a private copy is both safe and non-destructive.
    const temp = path.join(os.tmpdir(), `cursor-state-${process.pid}.vscdb`);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, temp + suffix);
    }
    try {
      return { db: new DatabaseSync(temp, { readOnly: true }), temp };
    } catch (inner) {
      throw new Error(`cannot open ${dbPath}: ${e.message}; copy also failed: ${inner.message}`);
    }
  }
}

function readAuth(dbPath) {
  const { db, temp } = openDatabase(dbPath);
  const out = {};
  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
    for (const [field, key] of Object.entries(AUTH_KEYS)) {
      const row = stmt.get(key);
      if (!row || row.value == null) continue;
      const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
      // Some entries are stored as a JSON string, others bare.
      let value = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") value = parsed;
      } catch {}
      out[field] = value.trim();
    }
  } finally {
    try {
      db.close();
    } catch {}
    if (temp) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(temp + suffix, { force: true });
        } catch {}
      }
    }
  }
  return out;
}

function readMachineIds(storagePath) {
  if (!fs.existsSync(storagePath)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    return {
      machineId: json["telemetry.machineId"] || "",
      macMachineId: json["telemetry.macMachineId"] || "",
    };
  } catch {
    return {};
  }
}

// A JWT's middle segment carries the expiry and the subject; showing those is
// enough to confirm the right account without ever printing the token.
function describeToken(token) {
  const parts = String(token).split(".");
  if (parts.length < 2) return { kind: "opaque", length: String(token).length };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    const exp = payload.exp ? new Date(payload.exp * 1000) : null;
    return {
      kind: "jwt",
      subject: payload.sub || null,
      expiresAt: exp ? exp.toISOString() : null,
      expired: exp ? exp.getTime() < Date.now() : null,
    };
  } catch {
    return { kind: "jwt", subject: null, expiresAt: null, expired: null };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, ""));
    return;
  }

  const found = locate(args.db);
  if (!found) {
    console.error("no Cursor installation found. Pass --db /path/to/state.vscdb");
    process.exit(1);
  }
  console.log(`reading ${found.db}`);

  const auth = readAuth(found.db);
  if (!auth.accessToken) {
    console.error("no cursorAuth/accessToken in that database — sign in to Cursor first");
    process.exit(1);
  }
  const ids = readMachineIds(found.storage);
  if (!ids.machineId) {
    console.error(`no telemetry.machineId in ${found.storage}; the checksum header will be wrong`);
  }

  const info = describeToken(auth.accessToken);
  console.log(`account : ${auth.email || info.subject || "unknown"}`);
  if (auth.membership) console.log(`plan    : ${auth.membership}`);
  if (info.expiresAt) console.log(`expires : ${info.expiresAt}${info.expired ? "  (EXPIRED)" : ""}`);
  console.log(`machine : ${ids.machineId ? ids.machineId.slice(0, 12) + "…" : "missing"}`);

  if (args.print) {
    console.log("\n--print: nothing written");
    return;
  }

  const outPath = path.resolve(args.out || path.join(__dirname, "..", "token.json"));
  const entry = {
    name: args.name || auth.email || "cursor-ide",
    kind: "sand",
    accessToken: auth.accessToken,
    machineId: ids.machineId || "",
    macMachineId: ids.macMachineId || "",
  };

  // Merging rather than overwriting: a token file is usually a pool of several
  // accounts, and clobbering the others to add one is rarely what was meant.
  let file = { tokens: [] };
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
      if (Array.isArray(existing.tokens)) file = existing;
    } catch {
      if (!args.force) {
        console.error(`${outPath} exists and is not valid JSON. Re-run with --force to replace it.`);
        process.exit(1);
      }
    }
  }
  const at = file.tokens.findIndex((t) => t && (t.name === entry.name || t.accessToken === entry.accessToken));
  if (at >= 0) file.tokens[at] = entry;
  else file.tokens.push(entry);

  fs.writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nwrote ${outPath} (${file.tokens.length} account${file.tokens.length === 1 ? "" : "s"})`);
  if (info.expired) console.log("warning: that token is already expired; sign in to Cursor again");
}

main();
