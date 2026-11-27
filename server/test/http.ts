import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isChildProfile, REQUEST_BODY_LIMIT } from "../../shared/child.ts";
import type { Child, Rule } from "../../shared/parent.ts";
import { createApp } from "../src/http.ts";

test("profiles return a ready-to-use prompt without calling a provider", async () => {
  const origin = "http://localhost:5173";
  const app = createApp({ childOrigins: [origin], fetchImpl: () => assert.fail("Profile access should be local") });
  const get = (path: string, browserOrigin = origin) => app(new Request("http://localhost" + path, {
    headers: { origin: browserOrigin },
  }));
  async function post<T>(path: string, body: unknown, status = 201): Promise<T> {
    const response = await app(new Request("http://localhost" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, status);
    return await response.json() as T;
  }

  assert.equal((await get("/profile")).status, 400);
  const topic = await post<Rule>("/api/parent/rules", { label: "Test topic" });
  const child = await post<Child>("/api/parent/children", {
    displayName: "Maya", age: 8, note: 'Likes "planets".\nKeep examples short.', ruleIds: [topic.id],
  });
  const path = "/profile?childId=" + child.id;
  const response = await get(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const blocked = await get(path, "https://other.test");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  const payload = await response.json();
  assert.ok(isChildProfile(payload));
  const { prompt, ...profile } = payload;
  assert.deepEqual(profile, { displayName: "Maya", rulesVersion: 1 });
  assert.match(prompt, /Child profile: Maya, age 8/);
  assert.match(prompt, /Parent's note for choosing tone and examples only: "Likes \\"planets\\"\.\\nKeep examples short\."/);
  assert.match(prompt, /Reply in English/);
  assert.match(prompt, /Forbidden topics:\n- Test topic$/);

  await post<Child>("/api/parent/children/" + child.id, { displayName: "Maya" }, 200);
  const updated = await (await get(path)).json();
  assert.ok(isChildProfile(updated));
  assert.equal(updated.rulesVersion, 2);
  assert.match(updated.prompt, /Child profile: Maya\n/);
  assert.doesNotMatch(updated.prompt, /Parent's note|Forbidden topics/);
  assert.equal((await get("/profile?childId=" + randomUUID())).status, 404);
  assert.equal((await get("/profile?childId=broken")).status, 400);
});

test("the former token, transcript and completion routes are absent", async () => {
  const app = createApp({ fetchImpl: () => assert.fail("Retired routes should not call a provider") });
  for (const path of ["/api/child/token", "/api/child/turn", "/v1/chat/completions"]) {
    const response = await app(new Request("http://localhost" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(response.status, 404);
  }
});

test("a child conversation is registered locally for a valid profile and rules version", async () => {
  const app = createApp({ fetchImpl: () => assert.fail("Conversation registration should be local") });
  const origin = "http://127.0.0.1:5173";
  function post(path: string, payload: unknown, browserOrigin = origin) {
    return app(new Request("http://localhost" + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: browserOrigin },
      body: JSON.stringify(payload),
    }));
  }
  const child = await (await post("/api/parent/children", { displayName: "Test child" })).json() as Child;
  const path = "/api/child/conversations";
  for (const rulesVersion of [undefined, "1", 0, 1.5]) {
    assert.equal((await post(path, { childId: child.id, rulesVersion })).status, 400);
  }
  assert.equal((await post(path, { childId: "invalid", rulesVersion: 1 })).status, 400);
  assert.equal((await post(path, { childId: randomUUID(), rulesVersion: 1 })).status, 404);
  assert.equal((await post(path, { childId: child.id, rulesVersion: 2 })).status, 404);
  const payload = { childId: child.id, rulesVersion: child.rulesVersion };
  assert.equal((await post(path, payload, "https://other.test")).status, 403);
  const response = await post(path, payload);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const body = await response.json() as { conversationId: string };
  assert.deepEqual(Object.keys(body), ["conversationId"]);
  assert.match(body.conversationId, /^[0-9a-f-]{36}$/);
});

test("an oversized streaming upload receives HTTP 413 before the upload finishes", { timeout: 5000 }, async (t) => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const server = spawn(process.execPath, [entry], {
    env: { ...process.env, DATABASE_PATH: ":memory:", HOST: "127.0.0.1", PORT: "0", TURN_REVIEW_DEBUG: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    server.kill();
  });
  const [message] = await once(server.stdout, "data");
  const url = String(message).trim().split(" ").at(-1);
  assert.ok(url);

  const reply = await new Promise<[number | undefined, string | undefined]>((resolve, reject) => {
    const upload = request(url + "/api/parent/children", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3000),
    }, (response) => {
      response.resume();
      resolve([response.statusCode, response.headers.connection]);
      upload.destroy();
    });
    upload.once("error", reject);
    upload.write(Buffer.alloc(REQUEST_BODY_LIMIT + 1, " "));
  });
  assert.deepEqual(reply, [413, "close"]);
});

test("parent writes reject embedded NUL in text fields before saving", async () => {
  const app = createApp();
  const origin = "http://localhost";
  const children = "/api/parent/children";
  const rules = "/api/parent/rules";
  for (const [path, payload] of [
    [children, { displayName: "\u0000Maya" }],
    [children, { displayName: "Maya", note: "Likes stars\u0000and planets" }],
    [rules, { label: "\u0000Test topic" }],
  ] as const) {
    const response = await app(new Request(origin + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await (await app(new Request(origin + children))).json(), []);
  assert.deepEqual(await (await app(new Request(origin + rules))).json(), []);
});
