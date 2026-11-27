import { expect, test, vi } from "vitest";
import { ChildServerError, createTransport } from "./transport";

const config = {
  workerUrl: "https://worker.test",
  vibeToken: "vibe",
  childServerUrl: "http://127.0.0.1:8788",
};
const childProfile = {
  displayName: "Alex",
  prompt: "Use short replies.\n\nReply in English.\n",
  rulesVersion: 1,
};

test("registers a child conversation without sending an interview token to the profile server", async () => {
  const conversationId = "d00e62fc-3e94-4625-ace8-73895af44eb6";
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ conversationId, token: "ignore" }, { status: 201 }));
  const transport = createTransport(config, fetchImpl);
  const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
  await expect(transport.startChildConversation(id, 4)).resolves.toEqual({ conversationId });

  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:8788/api/child/conversations");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ childId: id, rulesVersion: 4 });
  expect(init.headers).toEqual({ "content-type": "application/json" });
});

test.each([undefined, "", "not-a-conversation"])("rejects child conversation registration with ID %s", async (conversationId) => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ conversationId }, { status: 201 }));
  const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
  await expect(createTransport(config, fetchImpl).startChildConversation(id, 4)).rejects.toMatchObject({
    name: "ChildServerError", message: expect.stringMatching(/invalid conversation id/i),
  });
});

test("profile server timeouts are distinct from voice-provider failures", async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
  const transport = createTransport(config, fetchImpl);
  const profileFailure = transport.childProfile("child");
  await expect(profileFailure).rejects.toBeInstanceOf(ChildServerError);
  await expect(profileFailure).rejects.toThrow(/could not load the child profile/i);
  const registrationFailure = transport.startChildConversation("child", 4);
  await expect(registrationFailure).rejects.toBeInstanceOf(ChildServerError);
  await expect(registrationFailure).rejects.toThrow(/could not register the child conversation/i);
});

test("retries a transient review error with the same ID, trimming context before sending", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ classification: "ok" }));
  const transport = createTransport(config, fetchImpl);
  const current = { input: "Последняя реплика", output: "Ответ" };
  const earlier = { input: "я".repeat(6000), output: "щ".repeat(6000) };
  const review = {
    childId: "child", conversationId: "conversation", turnId: "turn",
    occurredAt: new Date().toISOString(), turns: [...Array(9).fill(earlier), current],
  };
  await transport.reviewTurn(review);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:8788/api/child/turn-reviews");
  expect(fetchImpl.mock.calls[1][1].body).toBe(init.body);
  expect(new TextEncoder().encode(init.body).byteLength).toBeLessThanOrEqual(128 * 1024);
  const sent = JSON.parse(init.body);
  expect(sent.turnId).toBe(review.turnId);
  expect(sent.turns).toHaveLength(6);
  expect(sent.turns.at(-1)).toEqual(current);
});

test("fetches the prepared child prompt verbatim without sending the interview token", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json(childProfile));

  const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
  await expect(createTransport(config, fetchImpl).childProfile(id)).resolves.toEqual(childProfile);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:8788/profile?childId=" + id);
  expect(init.headers).toBeUndefined();
  expect(init.cache).toBe("no-store");
});

test.each([undefined, "", " \n ", 42])("rejects a profile with an invalid prepared prompt (%j)", async (prompt) => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...childProfile, prompt }));
  await expect(createTransport(config, fetchImpl).childProfile("child")).rejects.toThrow(/child profile/i);
});

test("rejects a profile that still provides only ingredients for a prompt", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({
    role: "child",
    displayName: "Alex",
    description: "Alex is 9.",
    rulesVersion: 1,
    forbiddenTopics: [],
  }));

  await expect(createTransport(config, fetchImpl).childProfile("child")).rejects.toThrow(/child profile/i);
});

test("a child profile must specify the rules version used to open its call", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({
    ...childProfile, rulesVersion: undefined,
  }));
  const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
  await expect(createTransport(config, fetchImpl).childProfile(id)).rejects.toThrow(/child profile/i);
});

test("a child link requests its own profile and reports a missing profile", async () => {
  const id = "a789682b-f6cc-4687-bd23-0b4839927eea";
  const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  await expect(createTransport(config, fetchImpl).childProfile(id)).rejects.toMatchObject({
    name: "ChildServerError", message: expect.stringMatching(/not found/i),
  });
  const [url] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:8788/profile?childId=" + id);
});

test("sends the client token and asks the Worker for a session token", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ token: "sess", agentId: "agent_1" }), { status: 200 }),
  );

  const out = await createTransport(config, fetchImpl).agentToken();

  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("https://worker.test/agent/token");
  expect(init.headers["x-vibe-token"], "the Worker gates on this").toBe("vibe");
  expect(out).toEqual({ token: "sess", agentId: "agent_1" });
});

test("surfaces a rejected token instead of returning nothing", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));

  await expect(createTransport(config, fetchImpl).agentToken()).rejects.toThrow(/401/);
});

test("asks the Worker for a Deepgram grant with the client token", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ token: "dg-jwt" }), { status: 200 }),
  );

  const out = await createTransport(config, fetchImpl).deepgramToken();

  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("https://worker.test/deepgram-token");
  expect(init.headers["x-vibe-token"]).toBe("vibe");
  expect(out).toEqual({ token: "dg-jwt" });
});

test("reads the engine, falling back to ElevenLabs on anything it does not know", async () => {
  const answer = (engine: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ engine }), { status: 200 }));

  expect(await createTransport(config, answer("deepgram")).engine()).toBe("deepgram");
  expect(await createTransport(config, answer("whisper")).engine()).toBe("elevenlabs");
});
