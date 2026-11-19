# Voice Lab history API

From the repository root, start the history API with Node.js 20 or newer. It runs separately from the frontend.

```sh
npm --prefix server start
```

The default address is `http://localhost:8788`. The server allows the frontend's
HTTP origins on `localhost` and `127.0.0.1` on ports 5173 and 4173. For deployment, set
`VITE_HISTORY_URL` in the frontend build to the history API's base URL and set
`HISTORY_ALLOWED_ORIGINS` on the server to add deployed frontend origins as a
comma-separated list. The history API is shared and has no interview-key
requirement.

Set `HISTORY_PORT` to change the listening port. By default, files are stored
in the server's ignored `data` directory. During deployment, set
`HISTORY_DATA_DIR` to a directory on a persistent volume outside the release
directory. Run one server process against that directory. Include deletion
markers when copying data to another host so deleted dialogues stay deleted.

Run `npm --prefix server test` for the HTTP integration and store unit tests. Both use
temporary directories. The [history test cases](../spec/test_cases.md) link each scenario to its tests.
