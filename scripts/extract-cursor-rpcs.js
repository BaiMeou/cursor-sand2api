#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");

const services = new Set();
const rpcs = new Set();
const typeNames = new Set();
const methodByService = new Map();

for (const m of s.matchAll(/\/((?:aiserver|agent|anyrun)\.v1\.[A-Za-z0-9]+Service)\/([A-Za-z0-9]+)/g)) {
  rpcs.add(`/${m[1]}/${m[2]}`);
  services.add(m[1]);
  if (!methodByService.has(m[1])) methodByService.set(m[1], new Set());
  methodByService.get(m[1]).add(m[2]);
}
for (const m of s.matchAll(/((?:aiserver|agent|anyrun)\.v1\.[A-Za-z0-9]+Service)/g)) {
  services.add(m[1]);
}
for (const m of s.matchAll(/typeName:"((?:aiserver|agent|anyrun)\.v1\.[A-Za-z0-9]+)"/g)) {
  typeNames.add(m[1]);
}
// connect-es method tables: {name:"Foo", I:..., O:..., kind: ...}
for (const m of s.matchAll(/typeName:"((?:aiserver|agent|anyrun)\.v1\.[A-Za-z0-9]+Service)"[\s\S]{0,4000}?methods:\{/g)) {
  const svc = m[1];
  const start = m.index + m[0].length;
  const slice = s.slice(start, start + 8000);
  const end = slice.indexOf("}}");
  const body = end >= 0 ? slice.slice(0, end) : slice;
  if (!methodByService.has(svc)) methodByService.set(svc, new Set());
  for (const mm of body.matchAll(/name:"([A-Z][A-Za-z0-9]+)"/g)) {
    methodByService.get(svc).add(mm[1]);
    rpcs.add(`/${svc}/${mm[1]}`);
  }
}

const out = {
  source: src,
  bytes: s.length,
  serviceCount: services.size,
  rpcCount: rpcs.size,
  services: [...services].sort(),
  rpcs: [...rpcs].sort(),
  typeNames: [...typeNames].sort(),
  methods: Object.fromEntries(
    [...methodByService.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, [...v].sort()])
  ),
};
const dest = path.join(__dirname, "cursor-rpc-inventory.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  dest,
  serviceCount: out.serviceCount,
  rpcCount: out.rpcCount,
  services: out.services,
  methods: out.methods,
}, null, 2));
