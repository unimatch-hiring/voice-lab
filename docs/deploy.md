# Deploy

Two independent pieces.

## Frontend — GitHub Pages

[`deploy.yml`](../.github/workflows/deploy.yml) builds and publishes on push to `main`.
`VITE_WORKER_URL` comes from a repository variable: the Worker's address is not a secret,
it is gated by its origin list and by the client token.

`VITE_VIBE_TOKEN` is deliberately absent from the published build — it spends a paid quota.
Live mode is unlocked by pasting the token into the page, where it is kept in IndexedDB
under a non-extractable key (see [`tokenStore.ts`](../src/lib/tokenStore.ts)).

## Worker — Cloudflare

[`worker.yml`](../.github/workflows/worker.yml) runs only on changes under `worker/`, so a
frontend edit never redeploys the service that holds the API keys.

Needs two repository secrets:

- `CLOUDFLARE_API_TOKEN` — scoped to `Workers Scripts: Edit` on one account. No DNS, no
  zones, no billing.
- `CLOUDFLARE_ACCOUNT_ID`

The provider keys (`ELEVENLABS_API_KEY`, `VIBE_TOKEN`, `ADMIN_TOKEN`) are bound to the
Worker with `wrangler secret put` and are untouched by a deploy, so they never pass through
CI. `AGENT_ID` is plain `[vars]` — a session token is still required, so it is not a secret.

## Interview keys

Candidates get their own short-lived keys instead of our permanent `VIBE_TOKEN`, issued
from `?admin` and kept in the `KEYS` KV namespace. Setup and the endpoints:
[`worker/README.md`](../worker/README.md).

## Recording fixtures

`?record` adds a control that saves the conversation to a JSON file when it ends — lines
with timings plus the metrics of every turn. It is off unless asked for, so the published
page is unchanged. The files it produces are what an analysis exercise runs on when there
is no live agent to talk to.

## Origins

`ALLOWED_ORIGINS` in [`wrangler.toml`](../worker/wrangler.toml) lists who may call the
Worker; everyone else gets 403. It includes `:5173` for the dev server and `:4173` for
`vite preview`, because checking the production build locally runs on the latter.
