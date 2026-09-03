[English](../deployment.md) | **中文**

# 部署

本转换器是给你**自己身边**用的：工作站，或**你**拥有 Cursor 凭据的虚拟机。它不是多租户 SaaS。

硬规则：

- 绑定 **`127.0.0.1`**。TLS 和公网套接字放在反向代理上，不要放在 Node 上。
- 设置 **`API_KEY`**。若 `HOST` 不是回环且 `API_KEY` 为空，进程会**退出**。
- 任何不是你个人笔记本的主机都设 **`WEB_UI=off`**。控制台是无需鉴权的静态文件。
- **不要**在 `HOST=0.0.0.0` 时设 `WEB_UI=on`。
- `token.json` 模式 `0600`，属服务用户所有，不进 git，不进镜像。

## systemd（通用）

安装 Node 18.18+（若该 unit 会跑 `npm run token` 则 22.5+）。把树解压到你选的目录，例如 `/opt/cursor-sand2api`。在那里跑 `npm ci --omit=dev`。

`/etc/systemd/system/cursor-sand2api.service`：

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

优先用 `EnvironmentFile=/etc/cursor-sand2api.env`（模式 `0600`），而不是把 `API_KEY` 写进 unit 文件。然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cursor-sand2api
curl -sS http://127.0.0.1:13000/health
curl -sS -H 'Authorization: Bearer change-me-to-a-long-random-string' http://127.0.0.1:13000/v1/models
```

`GET /health` 公开，只返回 `{ status, version, tokens: { total, healthy } }`。运维字段在 `GET /health/detail`，需要密钥。

回滚：保留上一份树（例如 `/opt/cursor-sand2api.bak`）并把 `WorkingDirectory` / `ExecStart` 指回去，或解压上一份 tarball 再 `systemctl restart`。

`TOOL_MODE=client` 表示工具跑在 **OpenAI 调用方**上，不是这台主机。不要在共享虚拟机上启用 `TOOL_MODE=workspace` 或 `ENABLE_SHELL=1`。

## 反向代理

在代理上终止 TLS。转发到 `http://127.0.0.1:13000`。只要除你以外的人能碰到代理，就在边缘加你自己的鉴权。转换器在 `/v1/*` 上仍要求 `API_KEY`。

对 SSE 关闭缓冲（`/v1/chat/completions` 和 `/v1/responses` 且 `"stream": true`）。空闲超时必须超过 Cursor 的思考时间（分钟级，不是 30 秒）。

### Caddy 草案

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

### nginx 草案

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

不要把 `/` 代理到仍开着 `WEB_UI=on` 的主机。`WEB_UI=off` 时 `/` 是 404，`/v1/*` 不变。

## 容器

若用 Docker 或类似方式包装：

- `--network` **不要**把 `13000` 发布到 `0.0.0.0`，除非前面的代理是唯一监听者。
- 把 `token.json` 挂成 secret / volume，不要在 Dockerfile 里 `COPY`。
- 运行时传入 `API_KEY`。
- `WEB_UI=off`。

## 检查清单

- [ ] `HOST=127.0.0.1`
- [ ] `API_KEY` 已设置，且不是文档占位符
- [ ] `WEB_UI=off`
- [ ] `token.json` 存在，模式 `0600`，不在镜像里
- [ ] `curl /health` → 只有 `status` + `version` + token 计数
- [ ] 不带密钥 `curl /health/detail` → 401（设置了 `API_KEY` 时）
- [ ] 经代理的流式仍能送达 SSE
- [ ] 你接受 [docs/zh/disclaimer.md](./disclaimer.md)

Windows / macOS 工作站安装可以跳过 systemd：`HOST=127.0.0.1 API_KEY=changeme npm start` 就够了。只在该回环 URL 上使用 Web 控制台。
