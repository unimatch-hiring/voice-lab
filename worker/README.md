# voice-lab token-minter

Hands single-use ElevenLabs tokens to the client and proxies LLM requests (text).
No audio flows through the Worker — just a short JSON with a token.

## Deploy

There are no zones on the account, so the address will be `*.workers.dev`.

```sh
cd worker
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put VIBE_TOKEN           # shared client secret, issued per session
wrangler deploy
```

Never write secrets to files. Rotate `VIBE_TOKEN` regularly.

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
