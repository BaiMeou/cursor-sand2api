# Contributing

**English** | [中文](./CONTRIBUTING.zh-CN.md)

Thanks for helping. This repository is **`private: true`** on purpose: it is not an npm package. Contributions are source patches, not a registry release.

Please read [docs/disclaimer.md](docs/disclaimer.md) first. This is an unofficial converter. Do not submit changes whose only purpose is to hide usage from Cursor or to impersonate another user’s membership.

## Prerequisites

- **Node.js 18.18+** to run the server and the unit tests.
- **Node.js 22.5+** if you need `npm run token` (`node:sqlite`).
- A throwaway or your own Cursor login for any live probe you choose to run. Live scripts spend real quota; they are not required for a PR.

## Setup

```bash
git clone https://github.com/BaiMeou/cursor-sand2api.git
cd cursor-sand2api
npm install
cp token.json.example token.json   # then fill with YOUR credentials, locally only
cp .env.example .env               # optional
```

Do not commit `token.json`, `.env`, or any file that contains a JWT or `crsr_` key.

## Tests

The suite is Node’s built-in runner. No extra test framework.

```bash
npm test
```

That is `node --test test/*.test.js`. A PR that changes protocol, errors, health, listen guards, or the OpenAI facades should add or update a test in `test/`.

Optional live checks (burn quota, need a running server and a filled `token.json`):

```bash
npm start
# in another shell
npm run live
npm run live:responses
```

Do not point live scripts at a shared deployment in a pull request.

## Pull requests

- Keep diffs small and on one topic.
- **No secrets in PRs**: no `token.json`, no `token-*.json`, no `.env`, no screenshots of the web console that show a real API key, no CI logs with `Authorization` headers.
- Do not add `token.json` to the commit even if git asks. The file is gitignored; do not force-add it.
- Do not introduce new environment variables without documenting them in [docs/configuration.md](docs/configuration.md) and `.env.example`.
- Do not document or commit private hostnames, cluster IPs, or other people’s emails.
- Match the existing CommonJS style. `npm test` must stay green.

## What not to send

- Copies of Cursor’s proprietary `app.asar` / workbench bundles.
- Harvested third-party credentials.
- “Bypass geo” or “unlimited quota” patches.
- Changes that put operator internals back on public `GET /health`.

## Protocol notes

Sand chat’s default upstream is `aiserver.v1.InferenceService/Stream`. `agent.v1.AgentService/Run` rejects sand JWTs (`Sand traffic is not supported`). Official `crsr_` keys go through `@cursor/sdk`, not a fake OpenAI URL on `api.cursor.com`. See [docs/advanced/reverse-engineering.md](docs/advanced/reverse-engineering.md).

## License

This project is [AGPL-3.0-or-later](./LICENSE). By opening a PR you license your contribution under the same terms.
