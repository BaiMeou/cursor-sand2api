# Deployment

**English** | [中文](./zh/deployment.md)

This converter is meant to run **next to you**: a workstation, or a VM where **you** own the Cursor credentials. It is not a multi-tenant SaaS.

Hard rules:

- Bind **`127.0.0.1`**. Put TLS and the public socket on a reverse proxy, not on Node.
- Set **`API_KEY`**. The process **exits** if `HOST` is not loopback and `API_KEY` is empty.
- Set **`WEB_UI=off`** on any host that is not your personal laptop. The console is unauthenticated static files.
- **Do not** set `WEB_UI=on` with `HOST=0.0.0.0`.
- `token.json` mode `0600`, owned by the service user, not in git, not in the image.

## systemd (generic)

Install Node 18.18+ (22.5+ if this unit will run `npm run token`). Unpack the tree to a directory you choose, for example `/opt/cursor-sand2api`. Run `npm ci --omit=dev` there.

`/etc/systemd/system/cursor-sand2api.service`:

```ini
[Unit]
Description=cursor-sand2api (unofficial Cursor → OpenAI converter)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sand2api
Group=sand2api
WorkingDirectory=/opt/cursor-sand2api
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=13000
Environment=API_KEY=change-me-to-a-long-random-string
Environment=WEB_UI=off
Environment=TOKEN_FILE=/opt/cursor-sand2api/token.json
Environment=TOOL_MODE=client
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Prefer an `EnvironmentFile=/etc/cursor-sand2api.env` (mode `0600`) over putting `API_KEY` in the unit file. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cursor-sand2api
curl -sS http://127.0.0.1:13000/health
curl -sS -H 'Authorization: Bearer change-me-to-a-long-random-string' http://127.0.0.1:13000/v1/models
```

`GET /health` is public and only returns `{ status, version, tokens: { total, healthy } }`. Operator fields live on `GET /health/detail` and need the key.

Roll back by keeping the previous tree (for example `/opt/cursor-sand2api.bak`) and pointing `WorkingDirectory` / `ExecStart` back, or by unpacking the previous tarball and `systemctl restart`.

`TOOL_MODE=client` means tools run on **the OpenAI caller**, not on this host. Do not enable `TOOL_MODE=workspace` or `ENABLE_SHELL=1` on a shared VM.

## Reverse proxy

Terminate TLS on the proxy. Forward to `http://127.0.0.1:13000`. Require your own auth at the edge if anyone but you can reach the proxy. The converter still requires `API_KEY` on `/v1/*`.

Disable buffering for SSE (`/v1/chat/completions` and `/v1/responses` with `"stream": true`). Idle timeouts must exceed Cursor’s think time (minutes, not 30 seconds).

### Caddy sketch

```caddy
# Replace example.com with your hostname. This file uses no real inventory names.
example.com {
    reverse_proxy 127.0.0.1:13000
    request_body {
        max_size 64MB
    }
    flush_interval -1
}
```

### nginx sketch

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Do not proxy `/` to a host that still has `WEB_UI=on`. With `WEB_UI=off`, `/` is 404 and `/v1/*` is unchanged.

## Containers

If you wrap this in Docker or similar:

- `--network` that does **not** publish `13000` to `0.0.0.0` unless a proxy in front is the only listener.
- Mount `token.json` as a secret / volume, not `COPY` in the Dockerfile.
- Pass `API_KEY` at runtime.
- `WEB_UI=off`.

## Checklist

- [ ] `HOST=127.0.0.1`
- [ ] `API_KEY` set and not the documentation placeholder
- [ ] `WEB_UI=off`
- [ ] `token.json` exists, mode `0600`, not in the image
- [ ] `curl /health` → `status` + `version` + token counts only
- [ ] `curl /health/detail` without a key → 401 (when `API_KEY` is set)
- [ ] Streaming through the proxy still delivers SSE
- [ ] You accept [docs/disclaimer.md](./disclaimer.md)

Windows / macOS workstation installs can skip systemd: `HOST=127.0.0.1 API_KEY=changeme npm start` is enough. Use the web console only on that loopback URL.
