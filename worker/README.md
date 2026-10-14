# voice-lab token-minter

Hands single-use ElevenLabs tokens and Deepgram grants to the client.
No audio flows through the Worker — just a short JSON with a token.

## Deploy

There are no zones on the account, so the address will be `*.workers.dev`.

```sh
cd worker
wrangler secret put ELEVENLABS_API_KEY
wrangler deploy
```

Never write secrets to files.

Merging a change under `worker/` to `main` deploys it: after CI passes,
[`worker.yml`](../.github/workflows/worker.yml) (**Deploy Worker**) runs
`wrangler deploy` with the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. A commit that does not touch `worker/` still gives a green run, but
its Deploy step is skipped, so a green run alone does not mean something shipped.

If the token is ever missing, the step **Check the deploy credentials exist** fails with the
fix in the run summary. Put a token with `Workers Scripts: Edit` back
(`gh secret set CLOUDFLARE_API_TOKEN`) and re-run the workflow. Until then a change can be
shipped by hand with `wrangler deploy`.

## Interview keys

Every caller, us included, uses a key issued from the admin page (`?admin` on the frontend)
and stored in the `KEYS` namespace under a TTL, so it expires on its own and revoking one
does not disturb anybody else's. There is no permanent token.

Live since 13.08.2026: the namespace is bound in `wrangler.toml`.

| | |
|---|---|
| `POST /admin/keys` | issue one; body `{hours, label}`, capped at 24h |
| `GET /admin/keys` | list the live ones |
| `DELETE /admin/keys/:token` | revoke immediately |
| `PATCH /admin/keys/:token` | switch the key's engine, body `{engine}`; the expiry stays |

All three need `x-admin-session` — a session from the sign-in below. A key handed to a
candidate never opens them; otherwise the candidate could issue more.

With Slack down nobody can sign in to issue one; a key can still be written straight into
KV by someone holding Cloudflare credentials, with an explicit lifetime:

```sh
wrangler kv key put --binding KEYS --remote --ttl 14400 "key:vibe_<random>" \
  '{"label":"ops","engine":"elevenlabs","issuedAt":<ms>,"expiresAt":<ms + 4h>}'
```

## Signing in

There is no admin password to pass around. The interviewer types their work email on
`?admin`, the Slack bot DMs them a code, and the code buys a 12-hour session.

| | |
|---|---|
| `POST /admin/signin` | `{email}` → always `{ok: true}` |
| `POST /admin/verify` | `{email, code}` → `{session, email}` |
| `GET/POST /admin/people`, `DELETE /admin/people/:email` | the allowlist |

`SLACK_BOT_TOKEN` is a Worker secret, shared with Hermes. The Worker calls one Slack
method, `chat.postMessage`, so `chat:write` is the only scope it depends on.

The allowlist lives in KV as `admin:<email>` → their Slack user ID, which is where the
code is sent; the address only names them. Adding somebody is a write, not a deploy, and
removing them ends their live sessions at once — every request re-checks the list.

The code is eight digits, single use, dead after ten minutes or five wrong tries. One
address gets at most three codes per 15 minutes and ten per day. The code and its tries
live in a Durable Object per address (`AddressGuard`, `guard.js`), which counts atomically,
so twenty parallel guesses spend twenty tries, not one. Neither the code nor the session
is stored in the clear, and both answers to `/admin/signin` are identical, DM included:
it is sent after the response so the two do not differ by a stopwatch either.

More than ten wrong codes, or more than ten code requests, for one address within ten
minutes DMs every admin on the list, at most once per ten minutes per address. Every
failed guess is also a `console.warn` (`signin verify failed`) in `wrangler tail`.

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

## Backup engine

Each issued key carries an engine, `elevenlabs` (default) or `deepgram`, set when the
key is issued or switched later from the admin page. The page asks before every
conversation, so a switch applies to the next one.

| | |
|---|---|
| `POST /engine` | `{engine}` for the caller's key; keys issued before engines existed answer `elevenlabs` |
| `POST /deepgram-token` | `{token}` — a 30-second grant from `POST /v1/auth/grant` |

A key mints only for its own engine: `/agent/token` answers `403` to a Deepgram key and
`/deepgram-token` to an ElevenLabs one.

`DEEPGRAM_API_KEY` is a Worker secret. The grant endpoint needs a key with at least the
Member role; a Default key gets `403` and the page reports the start as failed. The LLM and
the voice are Deepgram-managed, so no other provider key is involved.

## Rate limits

Workers Rate Limiting bindings in `wrangler.toml`, all per minute. They count per
Cloudflare location and are approximate; the exact counting is `AddressGuard`'s.

| binding | key | limit |
|---|---|---|
| `SIGNIN_LIMIT` / `SIGNIN_IP_LIMIT` | address / caller IP | 5 / 10 |
| `VERIFY_LIMIT` / `VERIFY_IP_LIMIT` | address / caller IP | 10 / 20 |
| `TOKEN_KEY_LIMIT` | hash of the key; minting and `/engine` counted apart | 6 |
| `TOKEN_IP_LIMIT` | caller IP, checked before the key is looked up | 30 |

Over the limit is `429`. The token limits are approximate (Cloudflare Rate Limiting counts asynchronously, so a burst can get one or two past six); the exact counter guards sign-in only.

## Local development

`.dev.vars` (gitignored, never commit):

```
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
```

A key for local runs goes into the local KV:
`wrangler kv key put --binding KEYS --local "key:vibe_dev" '{"engine":"deepgram","expiresAt":<ms>}'`.

`wrangler dev` → http://localhost:8787
