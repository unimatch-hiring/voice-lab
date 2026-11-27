# Parent control

Parents create child profiles, assign forbidden topics, and review alerts from child calls.
Each profile has a shareable `?child=<id>` link and shows its own alerts. The profile list
shows unread counts. `?alerts` shows alerts across the parent's profiles.

## Accounts and links

Open `/voice-lab/?parent=local-parent`. The browser replaces `?parent` with that address on
the current site's base path. Both URLs load the same static entry on GitHub Pages. An
unknown parent ID opens an invalid-link page.

SQLite creates `local-parent` in `accounts` with the `parent` role. Children also have
accounts, with the `child` role, and `parent_children` links them to the parent. The server
uses this single parent for every management request. Parent sign-in and per-user
authorization are still to come. Keep the API on loopback or behind a private access
boundary. A child link gives access to that profile's prompt, so share it privately.

## Client and server

[`src/parent/`](../src/parent/) contains the profile editor and alert views. The browser
calls a separate Node.js 24 service under [`server/`](../server/README.md). The service
initializes SQLite and owns profiles, topics, rules versions, conversations and
alerts. Profile management works without a provider key.

Demo and child calls use the same interview key. The Worker selects the engine and
issues the voice credential. Voice provider API keys stay in the Worker. The profile
server uses its OpenRouter key for reviews.

The profile server builds the prompt from the child's profile and assigned topics.
`GET /profile?childId=<id>` returns the display name, prompt, and rules version. The
browser passes the prompt to the voice provider and registers the child and rules version
via `POST /api/child/conversations`. An asynchronous OpenRouter review uses that version
to check each submitted turn and stores flagged questions and evidence excerpts in SQLite.
See [the voice pipeline](pipeline.md#who-decides-the-role) and the [server setup](../server/README.md).

## Validation and tests

The client validates link IDs and the child profile response. The server checks browser
origins, JSON content type, the 128 KiB request limit, field types, and references to stored
profiles, conversations and topics. SQLite foreign keys enforce relationships. Profile
writes run in a transaction, and changing the selected topics creates a rules version.

The server checks each review finding against the call's rules version and requires a
verbatim quote from the current turn. A retry for the same conversation and turn reuses a
stored alert.

`npm test` covers routing, the profile and alert views, and SDK callbacks.
`npm --prefix server test` covers request validation, migrations, conversation registration and review
with fake providers. `npm run build` type-checks both and builds the static client.
