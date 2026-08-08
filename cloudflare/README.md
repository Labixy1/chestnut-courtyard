# Cloudflare deployment

The local Python service remains the full steward runtime. Cloudflare provides
an owner-only online runtime for conversation, event logging, and media
generation.

1. Create a private GitHub repository and connect it to Cloudflare Pages.
2. Use `python3 scripts/build_cloud.py` as the build command and `dist` as the
   output directory.
3. Protect the Pages project with Cloudflare Access and set `OWNER_EMAIL`.
4. Bind `COZY_STATE` (KV), `COZY_PRIVATE` (private R2), and `COZY_MEDIA` (R2).
5. Add API secrets in Cloudflare, never in GitHub:
   `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GLM_API_KEY`, `QWEN_API_KEY`, and
   `ARK_API_KEY` as needed.
6. Set actual model IDs through the `COZY_*_MODEL` variables when an account
   exposes a different model name.

The 23:30 scheduled handler currently records a tick but does not distill
memory. Distillation is deliberately paused until the memory policy is agreed.

## Public read-only deployment

Build and verify the privacy-filtered bundle before deploying it:

```sh
python3 scripts/build_cloud.py
python3 scripts/cloud_privacy_test.py
cd cloudflare
wrangler deploy --config wrangler.public.toml
```

`wrangler.public.toml` publishes only the filtered `dist/` bundle and sets
`PUBLIC_READ_ONLY=true`, so every write request is rejected. It does not bind
private storage or API secrets. Keep the full owner runtime local until
Cloudflare Access, KV, R2 and secret bindings are configured.
