#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const exportFile = process.argv[2] || path.join(process.cwd(), "sand-accounts.json");
const tokenFile = process.argv[3] || path.join(__dirname, "..", "token.json");
const exported = JSON.parse(fs.readFileSync(exportFile, "utf8"));
const current = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
const list = Array.isArray(current) ? current : current.tokens || [];
const machine = list.find((t) => t && t.machineId) || {};

function emailOf(t) {
  return String((t && (t.name || t.email || t.label)) || "").toLowerCase();
}

const byEmail = new Map(list.map((t) => [emailOf(t), t]));
for (const acc of exported.accounts || []) {
  const email = String(acc.email || "").toLowerCase();
  const jwt = acc.items && acc.items["cursorAuth/accessToken"];
  if (!email || !jwt) continue;
  const existing = byEmail.get(email);
  if (existing && existing.kind === "api") continue;
  if (existing) {
    existing.accessToken = jwt;
    existing.kind = "sand";
    existing.name = acc.email;
    if (!existing.machineId) existing.machineId = machine.machineId || "";
    if (!existing.macMachineId) existing.macMachineId = machine.macMachineId || "";
    console.log("updated sand", acc.email, "plan", acc.plan);
  } else {
    list.push({
      name: acc.email,
      kind: "sand",
      accessToken: jwt,
      machineId: machine.machineId || "",
      macMachineId: machine.macMachineId || "",
    });
    console.log("added sand", acc.email, "plan", acc.plan);
  }
}

const out = Array.isArray(current) ? list : { ...current, tokens: list };
fs.writeFileSync(tokenFile, JSON.stringify(out, null, 2) + "\n");
const kinds = list.map((t) => `${t.kind}:${t.name}`).join(", ");
console.log("pool", kinds);
