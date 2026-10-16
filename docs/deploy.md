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

The provider keys (`ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `ADMIN_TOKEN`) are bound to the
Worker with `wrangler secret put` and are untouched by a deploy, so they never pass through
CI. `AGENT_ID` is plain `[vars]` — a session token is still required, so it is not a secret.
For the coach, `AGENT_ID` has to allow the LLM and language overrides as well as the
prompt, or the coach's conversation drops ([pipeline](pipeline.md)).

## Interview keys

Every caller gets a short-lived key, issued from `?admin` and kept in the `KEYS` KV
namespace; there is no permanent one. Setup and the endpoints:
[`worker/README.md`](../worker/README.md).

## Recording fixtures

`?record` adds a control that saves the conversation to a JSON file when it ends — lines
with timings plus the metrics of every turn. It is off unless asked for, so the published
page is unchanged. The files it produces are what an analysis exercise runs on when there
is no live agent to talk to.

## Origins

`ALLOWED_ORIGINS` in [`wrangler.toml`](../worker/wrangler.toml) lists who may call the
Worker; everyone else gets 403. It includes `:5173` for the dev server and `:4173` for
`vite preview`, because checking the production build locally runs on the latter. Previews, branch or fork, are
paths on the same `https://unimatch-hiring.github.io` origin and need no entry of their own.

## Branch previews

A branch pushed to this repository is published under
`https://unimatch-hiring.github.io/voice-lab/pr-preview/<branch>/`, so a change can be
looked at without merging it. Four live at once; past that the least recently touched are
dropped, because a merged-and-abandoned branch never fires the `delete` event that would
clean it up.

The link finds you rather than the other way round: a comment on the pull request (edited
in place, one per branch), a deployment entry on the branch, and the run's own summary.
Without the deployment GitHub shows a preview nowhere in its interface — it exists, but
only the workflow log knows the address.

Two consequences worth knowing.

The site is a branch (`gh-pages`), not an upload. `main`'s build replaces the root and
leaves `pr-preview/` alone; a preview writes only its own directory. Both take the same
concurrency group, so they cannot push over each other.

## Fork previews

A pull request from a fork is published under
`https://unimatch-hiring.github.io/voice-lab/pr-preview/pr-<N>/`, and the link arrives as
a comment on the pull request (one, edited in place) and as a `fork-preview` deployment
on it. The reviewer opens the link, pastes an access key into the page and talks to it —
nothing to run locally.

Publishing needs a write token, and fork code must never hold one, so the work is split
in two:

- [`preview-pr-build.yml`](../.github/workflows/preview-pr-build.yml) — `pull_request`,
  `contents: read`, no secrets. The only place the fork's code runs. It builds with the
  preview's base path and uploads `dist` plus the pull request number and head sha as an
  artifact. Nothing else leaves it.
- [`preview-pr-deploy.yml`](../.github/workflows/preview-pr-deploy.yml) — `workflow_run`,
  which always runs the copy on `main`, so a pull request cannot edit it. It holds the
  write token and runs no project code: no install, no build, nothing from the artifact.

The artifact is treated as hostile, because the fork's run could have uploaded anything:

- the pull request is looked up by the fork's head through the API — for forks
  `workflow_run.pull_requests` is empty — and must still point at the commit that was
  built; the number in the artifact must be digits and match it, or nothing is published;
- unpacking ([`unpack-artifact.py`](../.github/scripts/unpack-artifact.py)) rejects the
  whole artifact on an absolute path, `..`, a symlink, a `.git` entry, anything outside
  `site/`, or more than 5000 files / 200 MB;
- the comment is found by a hidden marker **and** the `github-actions[bot]` author, so a
  comment someone else plants with the marker is ignored.

A pull request opened before the fork preview reached `main` may never get a build: a
`pull_request` run takes its workflows from `refs/pull/<N>/merge`, and until GitHub
recomputes that merge it still sits on the old `main`. Reopening is not a reliable fix —
the event can fire before the recompute. Adding the `preview` label rebuilds the preview
of any fork pull request without closing it and without notifying its author; if even that
starts nothing, open the pull request (or `GET /pulls/<N>`) so GitHub recomputes the
merge, and label it again. A first-time contributor's own pushes still wait for a
maintainer to approve the run, as every workflow here does.

When the pull request closes,
[`preview-pr-cleanup.yml`](../.github/workflows/preview-pr-cleanup.yml) deletes its
directory, marks the deployment inactive and edits the comment. It uses
`pull_request_target` because the fork's own `pull_request` run cannot push; the risk of
that trigger is running the pull request's code with the write token, and this job checks
out nothing but `gh-pages` and takes the number from GitHub's event, not from the fork.

All four workflows that push `gh-pages` share the `gh-pages` concurrency group. Branch
previews and fork previews prune separately — four of each, oldest first — and neither
touches the other's directories; a branch whose name would turn into `pr-<N>` is published
as `branch-pr-<N>`. GitHub keeps only one pending run per concurrency group, so a cleanup
can occasionally be superseded; the next fork deploy also drops previews of closed pull
requests.

Two things this does not change. Whether a first-time contributor's run waits for
"Approve and run" is the organisation's Actions setting, untouched here. And a preview is
the candidate's JavaScript served from `unimatch-hiring.github.io`, the same origin as the
site: it can read the key saved in this browser (see
[`tokenStore.ts`](../src/lib/tokenStore.ts)). Review a fork's preview with a key issued for
that review, and forget it afterwards.
