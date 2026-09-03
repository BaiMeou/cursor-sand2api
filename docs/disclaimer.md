# Disclaimer

**English** | [中文](./zh/disclaimer.md)

**cursor-sand2api is unofficial.** It is not affiliated with, endorsed by, or supported by Anysphere, Cursor, or any model provider whose names appear in `/v1/models`. The Cursor name, product, and APIs are theirs.

This converter speaks **your** Cursor credentials to Cursor’s existing backends and restates the result as a small OpenAI-compatible HTTP surface. It is not a Cursor product, not a public Cursor API, and not a substitute for [Cursor’s official APIs and SDK](https://cursor.com/docs).

## Terms of service

Using this software means you send traffic that looks like (or is) Cursor IDE / Cursor API usage, billed and limited the same way Cursor already bills and limits that account. You are responsible for:

- complying with [Cursor’s Terms of Service](https://cursor.com/terms) and any model-provider terms that apply to your plan
- keeping credentials private
- any quota, spend, or account action that follows from the requests you send

Do not use this project to share one paid membership with people who are not allowed to use it, to evade plan limits, or to pretend this HTTP port is an official Cursor endpoint.

## Quota and billing

Every successful or retried turn spends **your** Cursor usage: sand / Bot weekly pool, IDE “Other Models” pool, official User API Key (`crsr_`) quota, or whatever bucket Cursor assigns to that credential and model. Listing a model on `GET /v1/models` does **not** mean the next call will succeed or that it is free.

Cursor may return `429` (rate / usage), `403` `plan_restricted` (plan cannot run that named model), or `403` `unsupported_region` (provider blocked for the account or egress region). Those are Cursor answers, not converter bugs.

## It may break

Cursor can change RPC paths, headers, checksums, model slugs, plan rules, or geo policy without notice. A sand JWT that works today can be rejected tomorrow (`Sand traffic is not supported` on `AgentService/Run` is already a hard example). Treat this project as a **best-effort, reverse-engineered adapter**. Pin a release, keep a rollback, and do not build a business that dies if Cursor changes a header.

See [limitations](./limitations.md) for the incomplete OpenAI surface and [credentials](./credentials.md) for how tokens are stored.

## License

The converter itself is [AGPL-3.0-or-later](../LICENSE). That governs **this** source, not Cursor’s. AGPL does not make a Cursor ToS violation legal.
