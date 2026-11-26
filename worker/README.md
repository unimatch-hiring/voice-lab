# voice-lab token-minter

Hands single-use ElevenLabs tokens and Deepgram grants to the client.
No audio flows through the Worker — just a short JSON with a token. It also proxies
OpenAI-style chat calls to OpenRouter for the candidate's server, metered per key
([LLM proxy](#llm-proxy-for-candidates)).

## Deploy

There are no zones on the account, so the address will be `*.workers.dev`.

```sh
cd worker
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put OPENROUTER_API_KEY   # the LLM proxy; without it /llm/ answers 503
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
| `POST /admin/keys` | issue one; body `{hours, label, engine, budgetUsd}`, capped at 24h, $5 of LLM and 30 keys an hour per admin; the only answer with the full key |
| `GET /admin/keys` | list the live ones: `id`, a masked `hint`, `spentUsd` / `budgetUsd` on the LLM proxy; never the key |
| `DELETE /admin/keys/:id` | revoke immediately; `id` is the SHA-256 of the key |
| `PATCH /admin/keys/:id` | switch the key's engine, body `{engine}`; the expiry stays |

All four need `x-admin-session` — a session from the sign-in below. A key handed to a
candidate never opens them; otherwise the candidate could issue more.

With Slack down nobody can sign in to issue one; a key can still be written straight into
KV by someone holding Cloudflare credentials, with an explicit lifetime:

```sh
wrangler kv key put --binding KEYS --remote --ttl 14400 "key:vibe_<random>" \
  '{"label":"ops","engine":"elevenlabs","issuedAt":<ms>,"expiresAt":<ms + 4h>}'
```

## Signing in

There is no admin password to pass around. The interviewer types their work email on
`?admin`, the Slack bot DMs them a code, and the code buys a 4-hour session.

| | |
|---|---|
| `POST /admin/signin` | `{email}` → always `{ok: true}` |
| `POST /admin/verify` | `{email, code}` → `{session, email}` |
| `POST /admin/signout` | ends the session in `x-admin-session` |
| `GET/POST /admin/people`, `DELETE /admin/people/:email` | the allowlist; nobody can remove themselves or the last admin |

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
Changing it needs no code edit: adjust `[vars]` and `wrangler deploy`.

The candidate's endpoints (`/engine`, `/agent/token`, `/deepgram-token`, `/llm/v1/…`) answer more:
`PREVIEW_ORIGINS`, `http://localhost` and `http://127.0.0.1` on any port (a candidate's
dev server), and requests with no `Origin` at all (a candidate's own backend, or curl). The
interview key is what guards them. Everything under `/admin/` answers `ALLOWED_ORIGINS`
only; any other origin, or no origin, gets `403`.

Every refusal — `403` origin, `401` key, `429` limit — writes one JSON line
(`reason`, `path`, `origin`, `method`; never a token, key or IP) to Workers Logs:
the dashboard under Workers → `voice-lab-token-minter` → Logs, or live with
`npx wrangler tail voice-lab-token-minter --format pretty`.

`PREVIEW_ORIGINS` is where pull request previews are served. They run unreviewed code,
so they reach only the candidate's endpoints (`/engine`, `/agent/token`,
`/deepgram-token`) and get `403` on everything under `/admin/`.

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

## LLM proxy for candidates

Task E needs an LLM (a phrase classifier) on the candidate's own server. They get no
OpenRouter key: they call the Worker with the same interview key, and the Worker calls
OpenRouter with `OPENROUTER_API_KEY`, a Worker secret that never appears in an answer,
an error or a log line (anything upstream echoes back is scrubbed).

| | |
|---|---|
| `POST /llm/v1/chat/completions` | OpenAI chat completions; `Authorization: Bearer vibe_…` (or `x-vibe-token`) |
| `GET /llm/v1/models` | the models the proxy allows |

Any OpenAI client works with base URL `<worker>/llm/v1` and the interview key as the API key.
This is what to tell the candidate when they ask for an LLM:

```sh
curl https://voice-lab-token-minter.shupilkin.workers.dev/llm/v1/chat/completions \
  -H "Authorization: Bearer $VIBE_KEY" -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":50,
       "messages":[{"role":"user","content":"Is this alarming: I am scared when dad shouts?"}]}'
```

```js
const client = new OpenAI({ baseURL: `${WORKER_URL}/llm/v1`, apiKey: process.env.VIBE_KEY });
```

What a call may do:

- **Models**: `LLM_MODELS` in `wrangler.toml`, cheap text models (`openai/gpt-4o-mini` and a
  few of its price class), no reasoning models. Anything else is `400` and lists the allowed
  ones. A model added there must cost under $10 per million tokens, see the budget below.
- **Input**: text only — `content` a string or parts of `type: "text"`; images, audio and
  files are `400`. `tools` only of `type: "function"`. The body is at most 64 kB (`413`).
- **`max_tokens`**: at most `LLM_MAX_TOKENS` (1024), and that when the call names none.
  Above it is `400`.
- **Streaming**: refused with `400`. A stream's cost arrives in its last chunk, and the
  classifier does not need one; send `stream: false`.
- Fields that would reroute or bill extra (`models`, `plugins`, `provider`, …) are dropped;
  `n` other than 1 is `400`.

**Budget.** Every key carries `budgetUsd`, $5 unless a smaller one is given at issue (more
is refused). Before a call the Worker reserves its worst case from the key's tally: input
bytes plus `max_tokens`, at $10 per million tokens, above every listed model (a byte-level
tokenizer makes at most one token per byte). A classifier call reserves about $0.03. If the
reservation does not fit what is left, the call is `402` (`insufficient_quota`) and nothing
goes to OpenRouter. After the answer the Worker refunds the difference to the cost
OpenRouter reports (`usage.cost`, asked for with `usage: {include: true}`). So parallel calls
cannot overspend together, a caller who hangs up mid-call keeps paying the reservation, and
an answer without a cost keeps it in full. An error answer from OpenRouter is refunded.

The tally lives in a Durable Object per key (`LlmBudget`, `llm.js`), not in KV: KV loses
updates when parallel calls each read-modify-write it, and refuses more than one write a
second per key. The object drops its tally when the key expires. Revoking or switching a
key's engine leaves the tally as it is. A revoked key can still reach the proxy for up to a
minute: KV reads are cached at the edge.

OpenRouter refusing our own key (`401`/`402`/`403`, e.g. the account ran out of credits)
reaches the candidate as `502` "tell the interviewer", so it does not read as their key or
budget being at fault. Workers Logs has `llm_upstream_refused` for it.

The admin page shows `LLM $0.42 / $5` next to each key, in red from 80%.

## Auditing the keys

`scripts/audit-keys.mjs` prints every live key — masked key, label, time left, LLM spend —
and flags what needs a look. It changes nothing; revoke from `?admin`.

```sh
node scripts/audit-keys.mjs you@unimatch.ai   # asks for the Slack code, signs out after
```

Run it at the end of every interview day and on Mondays. A clean run is `no live keys`,
or only keys of interviews still going on. Revoke on `?admin`:

- any key whose interview is over — the TTL would get it, but a leaked key works until then;
- `no label` — nobody can say whose it is;
- `issued for over 8h` — a session is ~80 minutes;
- `near LLM budget` — check the candidate's server is not looping before handing out another.

## Rate limits

Workers Rate Limiting bindings in `wrangler.toml`, all per minute. They count per
Cloudflare location and are approximate; the exact counting is `AddressGuard`'s.

| binding | key | limit |
|---|---|---|
| `SIGNIN_LIMIT` / `SIGNIN_IP_LIMIT` | address / caller IP | 5 / 10 |
| `VERIFY_LIMIT` / `VERIFY_IP_LIMIT` | address / caller IP | 10 / 20 |
| `TOKEN_KEY_LIMIT` | hash of the key; minting and `/engine` counted apart | 20 |
| `TOKEN_IP_LIMIT` | caller IP, checked before the key is looked up | 30 |
| `LLM_LIMIT` | `/llm/v1/`: caller IP, then hash of the key, counted apart | 120 |

Over the limit is `429`. The token limits are approximate (Cloudflare Rate Limiting counts asynchronously, so a burst can get one or two past the limit); the exact counter guards sign-in only.

## Local development

`.dev.vars` (gitignored, never commit):

```
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
OPENROUTER_API_KEY=...
```

A key for local runs goes into the local KV:
`wrangler kv key put --binding KEYS --local "key:vibe_dev" '{"engine":"deepgram","expiresAt":<ms>}'`.

`wrangler dev` → http://localhost:8787
