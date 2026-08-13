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

Interview keys need two more steps, and they are optional — see below.

Never write secrets to files. Rotate `VIBE_TOKEN` regularly.

## Interview keys

`VIBE_TOKEN` is ours and permanent. Candidates get their own keys, issued from the admin
page (`?admin` on the frontend) and stored in the `KEYS` namespace under a TTL, so they
expire on their own and revoking one does not disturb anybody else's.

Off until switched on, in this order — the binding is commented out in `wrangler.toml`
because a placeholder id fails the deploy, and this Worker deploys automatically on a
push to `main`:

```sh
wrangler kv namespace create KEYS   # prints the id
wrangler secret put ADMIN_TOKEN     # password for the admin page
# uncomment [[kv_namespaces]] in wrangler.toml, paste the id
wrangler deploy
```

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
