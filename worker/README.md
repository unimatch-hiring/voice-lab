# voice-lab token-minter

Hands single-use ElevenLabs tokens to the client and proxies LLM requests (text).
No audio flows through the Worker — just a short JSON with a token.

## Deploy

There are no zones on the account, so the address will be `*.workers.dev`.

```sh
cd worker
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put VIBE_TOKEN           # permanent client secret, ours
wrangler deploy
```

Never write secrets to files. Rotate `VIBE_TOKEN` regularly.

⚠️ **The automatic deploy is currently broken**: the repository has
`CLOUDFLARE_ACCOUNT_ID` but no `CLOUDFLARE_API_TOKEN`, so
[`worker.yml`](../.github/workflows/worker.yml) fails on authentication before it reads
any config. It last succeeded on 10.08.2026, so the token was there and is now gone.

Until a token with `Workers Scripts: Edit` is put back
(`gh secret set CLOUDFLARE_API_TOKEN`), a Worker change has to be deployed by hand with
`wrangler deploy`. Nothing is silently stale — the failed run is visible in Actions — but
merging a `worker/` change does not ship it.

## Interview keys

`VIBE_TOKEN` is ours and permanent. Candidates get their own keys, issued from the admin
page (`?admin` on the frontend) and stored in the `KEYS` namespace under a TTL, so they
expire on their own and revoking one does not disturb anybody else's.

Live since 13.08.2026: the namespace is bound in `wrangler.toml` and `ADMIN_TOKEN` is set.
The password is in Vault at `secret/t-ai/shared/voice-poc`, field `VOICE_LAB_ADMIN_TOKEN`,
next to this project's other secrets. To rotate it, write the new value to Vault first,
then `wrangler secret put ADMIN_TOKEN` — the other order loses the password on a slip.

Until `ADMIN_TOKEN` is set the admin endpoints answer 401 and no key can be issued;
minting session tokens with `VIBE_TOKEN` is unaffected either way.

The Worker accepts either: `VIBE_TOKEN` first, then a lookup in KV. With no `KEYS`
namespace bound the admin endpoints answer 404 and `VIBE_TOKEN` keeps working alone —
a deployment that never wanted this feature is unaffected.

| | |
|---|---|
| `POST /admin/keys` | issue one; body `{hours, label}`, capped at 24h |
| `GET /admin/keys` | list the live ones |
| `DELETE /admin/keys/:token` | revoke immediately |

All three require `x-admin-token`. It must not be a key handed to a candidate — otherwise
the candidate can issue more.

After deploying, put the address you get
(`https://voice-lab-token-minter.<subdomain>.workers.dev`) into the frontend's
`VITE_WORKER_URL` — see the root `README`.

## Who may call it

`ALLOWED_ORIGINS` in `wrangler.toml` is the list of origins the Worker answers.
Everyone else gets `403`. Changing it needs no code edit: adjust `[vars]` and
`wrangler deploy`.

For GitHub Pages the origin is the host only (`https://<org>.github.io`), without
the project path.

## Local development

`.dev.vars` (gitignored, never commit):

```
ELEVENLABS_API_KEY=...
VIBE_TOKEN=dev
```

`wrangler dev` → http://localhost:8787
