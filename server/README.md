# Profile server

The server stores profiles, rules and alerts in SQLite. It builds child prompts from saved
profiles, registers the rules version used for a call, and sends turns to OpenRouter for
review. The browser gets voice session credentials from the Worker.

## Run locally

Use Node.js 24 and run these commands from `server/`. Node runs the TypeScript in `src/`
directly.

```sh
npm ci
npm run db:init
npm start
```

`db:init` creates `server/.data/voice-lab.sqlite` and preserves existing data. `npm start`
runs the same initialization and listens on `http://127.0.0.1:8788` by default. From another
terminal, check that the API returns the child profiles as JSON.

```sh
curl -fsS http://127.0.0.1:8788/api/parent/children
```

## Configuration

Set server variables in the shell or in the ignored `server/.env.local`.

- `DATABASE_PATH` sets a custom SQLite path. Keep it outside the frontend workspace.
- `HOST` and `PORT` change the listener.
- `PARENT_CONTROL_ORIGINS` and `CHILD_VOICE_ORIGINS` set comma-separated browser
  allowlists. They default to localhost and 127.0.0.1 on the Vite dev and preview ports.
- `OPENROUTER_API_KEY` enables turn reviews and alerts.

Profile management works without provider keys or parent sign-in. Keep the API on loopback
or behind access control.

## Tests and debugging

Run `npm test` from `server/` to test the API and SQLite with fake providers. The root
`npm run build` type-checks both the server and client. On loopback outside production,
`TURN_REVIEW_DEBUG=1 npm start` writes transcripts and review verdicts to
`server/logs/turn-reviews.jsonl`.
