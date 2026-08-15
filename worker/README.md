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

Live since 13.08.2026: the namespace is bound in `wrangler.toml`.

| | |
|---|---|
| `POST /admin/keys` | issue one; body `{hours, label}`, capped at 24h |
| `GET /admin/keys` | list the live ones |
| `DELETE /admin/keys/:token` | revoke immediately |

All three need `x-admin-session` — a session from the sign-in below. A key handed to a
candidate never opens them; otherwise the candidate could issue more.

The Worker accepts either token for minting: `VIBE_TOKEN` first, then a lookup in KV.
With no `KEYS` namespace bound the admin endpoints answer 404 and `VIBE_TOKEN` keeps
working alone — a deployment that never wanted this feature is unaffected.

## Signing in

There is no admin password to pass around. The interviewer types their work email on
`?admin`, the Slack bot DMs them a code, and the code buys a 12-hour session.

| | |
|---|---|
| `POST /admin/signin` | `{email}` → always `{ok: true}` |
| `POST /admin/verify` | `{email, code}` → `{session, email}` |
| `GET/POST /admin/people`, `DELETE /admin/people/:email` | the allowlist |

`SLACK_BOT_TOKEN` is a Worker secret, shared with Hermes. The Worker calls exactly two
Slack methods: `users.lookupByEmail` and `chat.postMessage`.

The allowlist lives in KV under `admin:<email>`, so adding somebody is a write, not a
deploy. Removing them ends their live sessions at once — every request re-checks the list.

The code is eight digits, single use, dead after ten minutes or five wrong tries. Eight
rather than the customary six because the try counter lives in KV, which is not atomic
under parallel guesses — the reasoning is in `signin.js`. Neither the code nor the session
is stored in the clear, and both answers to `/admin/signin` are identical, DM included:
it is sent after the response so the two do not differ by a stopwatch either.

`ADMIN_TOKEN` survives for one job — seeding the allowlist and getting back in if Slack is
down. It cannot mint interview keys. Value in Vault, `secret/t-ai/shared/voice-poc`, field
`VOICE_LAB_ADMIN_TOKEN`; to rotate, write to Vault first, then `wrangler secret put
ADMIN_TOKEN`.

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
