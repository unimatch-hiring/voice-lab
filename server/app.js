import { ValidationError } from "./childService.js";

const MAX_BODY_BYTES = 64 * 1024;

/** HTTP only: routing and JSON in and out. What the data means is the service's business. */
export function createApp(service) {
  const routes = {
    "GET /api/settings": () => service.getSettings(),
    "PUT /api/settings": async (req) => service.saveSettings(await readJson(req)),
    "POST /api/flags/review": async (req) => service.reviewFlag(await readJson(req)),
    "GET /api/flags": () => service.listFlags(),
    "DELETE /api/child-data": () => service.deleteChildData(),
  };

  return async function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return send(res, 404, { error: "not found" });

    try {
      send(res, 200, await route(req));
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    }
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("body must be JSON");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
