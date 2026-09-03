#!/usr/bin/env bash
# Runs ON the target host, after the release tarball has been unpacked over
# /opt/cursor-sand2api. There is no git on that box — releases have always
# arrived as files — so this script only handles the parts that come after
# the copy: settings, restart, and proving the service came back.
#
#   sudo bash scripts/deploy-remote.sh
#
# Environment overrides:
#   APP_DIR   install root            (default /opt/cursor-sand2api)
#   UNIT      systemd unit name       (default cursor-sand2api)
#   WEB_UI    on|off                  (default off — the box is public)
#   PORT      health check port       (default 13000)

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cursor-sand2api}"
UNIT="${UNIT:-cursor-sand2api}"
WEB_UI="${WEB_UI:-off}"
PORT="${PORT:-13000}"
DROPIN="/etc/systemd/system/${UNIT}.service.d/webui.conf"

say() { printf '\n== %s\n' "$1"; }

say "release"
cd "$APP_DIR"
node -e 'const p=require("./package.json");console.log(p.name, p.version)'
printf 'src files: %s\n' "$(ls src | wc -l)"

# The console is unauthenticated at /, and this host answers on a public IP.
# Keeping it off is a deployment decision, so it lives in a drop-in rather
# than in the unit the repo does not own.
say "web console: ${WEB_UI}"
mkdir -p "$(dirname "$DROPIN")"
printf '[Service]\nEnvironment=WEB_UI=%s\n' "$WEB_UI" > "$DROPIN"

say "npm install"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

say "syntax check before restarting"
node --check server.js
for f in src/*.js; do node --check "$f"; done
echo "all files parse"

say "restart"
systemctl daemon-reload
systemctl restart "$UNIT"

say "waiting for health"
ok=""
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" -o /tmp/health.json 2>/dev/null; then
    ok="yes"
    break
  fi
  sleep 1
done

if [ -z "$ok" ]; then
  echo "SERVICE DID NOT COME BACK"
  systemctl status "$UNIT" --no-pager -l | tail -30
  journalctl -u "$UNIT" -n 40 --no-pager
  exit 1
fi

node -e '
  const h = require("/tmp/health.json");
  const tokens = h.tokens || {};
  console.log("status   :", h.status);
  console.log("version  :", h.version);
  console.log("tokens   :", (tokens.healthy ?? "?") + "/" + (tokens.total ?? "?"));
'
rm -f /tmp/health.json

say "web console reachability"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
if [ "$WEB_UI" = "off" ]; then
  [ "$code" = "404" ] && echo "/ returns 404 as intended" || echo "WARNING: / returned $code with WEB_UI=off"
else
  [ "$code" = "200" ] && echo "/ serves the console" || echo "WARNING: / returned $code with WEB_UI=on"
fi

say "done"
systemctl is-active "$UNIT"
