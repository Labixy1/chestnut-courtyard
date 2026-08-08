# Cloudflare deployment

Two deployments share the same source but never share owner data.

## Owner app

The owner Worker serves `dist-owner/`, runs before every static asset request,
and requires a signed HttpOnly passcode session. The passcode and session key
are Worker secrets; personal state lives in `COZY_STATE` KV. Cloudflare Access
can replace the passcode mode later without changing the frontend.

```sh
python3 scripts/build_cloud.py --mode owner
python3 scripts/cloud_owner_test.py
node scripts/cloud_worker_test.mjs
cd cloudflare
wrangler deploy --config wrangler.toml
```

Required secrets:

- `OWNER_PASSCODE`
- `SESSION_SECRET`

Optional model secrets, never committed to GitHub:

- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`
- `GLM_API_KEY`
- `QWEN_API_KEY` or `DASHSCOPE_API_KEY`
- `ARK_API_KEY`

When no external text key is configured, the Worker falls back to the bound
Cloudflare Workers AI model. R2 is optional. Until the account enables it,
event logs fall back to bounded KV storage and media uploads remain local-only.

The owner Worker cron runs at 08:00 Asia/Shanghai every two days. It collects
recent AI news candidates, asks the configured text model to keep only the
important items, and appends a new `notice_reports` entry. The same pipeline is
available from `/api/weekly/run` for a manual refresh. Blackboard questions and
grading also use the configured model and persisted memory context.

`workers.dev` URLs always include the Cloudflare account subdomain. Renaming a
Worker cannot hide that account segment; use a custom domain for a clean public
address, or change the account's Workers subdomain and accept the resulting
`worker-name.account-subdomain.workers.dev` format.

## Public preview

```sh
python3 scripts/build_cloud.py --mode preview
python3 scripts/cloud_privacy_test.py
cd cloudflare
wrangler deploy --config wrangler.public.toml
```

The preview publishes only `dist/`, uses the starter seed, and rejects every
write. It has no owner KV, model secret, memory, tree-hole data, private-room
data, uploads, logs, or owner photos.
