#!/usr/bin/env node
// Local Cursor install paths stay on the operator machine. Public scripts
// take the workbench bundle as argv or CURSOR_WORKBENCH.
const path = require("path");

function workbenchPath() {
  const raw = process.argv[2] || process.env.CURSOR_WORKBENCH || "";
  if (!raw) {
    console.error("usage: set CURSOR_WORKBENCH or pass workbench.desktop.main.js as argv[2]");
    process.exit(1);
  }
  return path.resolve(raw);
}

module.exports = { workbenchPath };
