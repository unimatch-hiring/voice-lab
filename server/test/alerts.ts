import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ReviewTurn, TurnReview } from "../../shared/child.ts";
import type { AlertFinding, AlertPage, Child, ChildSummary, Rule } from "../../shared/parent.ts";
import { openDatabase } from "../src/database.ts";
import { createApp } from "../src/http.ts";
import { openTurnDebugLog, type TurnDebugEntry, type TurnDebugLog } from "../src/turn-debug.ts";
import type { ReviewVerdict } from "../src/turn-reviews.ts";

const childrenPath = "/api/parent/children";
const alertsPath = "/api/parent/alerts";
const reviewsPath = "/api/child/turn-reviews";
const occurredAt = "2026-11-27T14:00:00.000Z";

type ReviewContext = { rules: Rule[]; previousTurns: ReviewTurn[]; currentTurn: ReviewTurn };
type ProviderRequest = { model: string; provider: unknown; response_format: { type: string }; messages: { content: string }[] };

function fixture(
  t: TestContext,
  classify: (context: ReviewContext) => unknown = () => ({ findings: [] }),
  openRouterKey = "test-only",
  turnDebugLog?: TurnDebugLog,
) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const requests: ProviderRequest[] = [];
  const app = createApp({
    db, openRouterKey: openRouterKey || undefined, turnDebugLog,
    async fetchImpl(url, init) {
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
      assert.ok(typeof init?.body === "string");
      const payload: ProviderRequest = JSON.parse(init.body);
      requests.push(payload);
      const result = await classify(JSON.parse(payload.messages[1].content));
      if (result instanceof Response) return result;
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    },
  });

  function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return app(new Request("http://localhost" + path, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }

  async function json<T>(path: string, body?: unknown, status = 200): Promise<T> {
    const response = await call(path, body);
    assert.equal(response.status, status);
    return await response.json() as T;
  }

  async function child(displayName: string, ruleIds: number[] = []) {
    return json<Child>(childrenPath, { displayName, ruleIds }, 201);
  }

  async function start(child: Child) {
    return json<{ conversationId: string }>("/api/child/conversations", {
      childId: child.id, rulesVersion: child.rulesVersion,
    }, 201);
  }

  return { db, call, json, child, start, requests };
}

function payload(
  { id: childId }: Child, { conversationId }: { conversationId: string }, input: string, output: string | null = null,
): TurnReview {
  return { childId, conversationId, turnId: randomUUID(), occurredAt, turns: [{ input, output }] };
}

function concern(quote: string, source: AlertFinding["evidence"]["source"] = "input") {
  return {
    kind: "concern", severity: 3, ruleId: null,
    description: "Сообщение требует внимания.", source, quote,
  };
}

test("reviews the last turn against the conversation's version and saves a single alert with both findings", async (t) => {
  const f = fixture(t, ({ rules }) => ({
    findings: [
      { kind: "forbidden_topic", severity: 1, ruleId: rules[0].id,
        description: "В ответе затронута запретная тема.", source: "output", quote: "Тема А" },
      concern("мне угрожают"),
    ],
  }));
  const oldRule = await f.json<Rule>("/api/parent/rules", { label: "Тема А" }, 201);
  const newRule = await f.json<Rule>("/api/parent/rules", { label: "Тема Б" }, 201);
  const child = await f.child("Майя", [oldRule.id]);
  const saved = await f.json<Child>(childrenPath + "/" + child.id, { ...child, ruleIds: [newRule.id] });
  assert.equal(saved.rulesVersion, 2);
  const grant = await f.start(child);
  const row = () => f.db.prepare("SELECT * FROM conversations WHERE id = ?").get(grant.conversationId);
  assert.equal(row()?.rules_version, 1);
  assert.equal(row()?.provider_session_id, null);
  assert.equal(row()?.status, "active");
  assert.equal((await f.call("/api/child/conversations/" + grant.conversationId + "/end",
    { childId: child.id, status: "ended" })).status, 204);
  assert.equal(row()?.status, "ended");

  const input = "Кто-то сказал, что мне угрожают.";
  const review = payload(child, grant, input, "Тема А. Остальная реплика.");
  const history = Array.from({ length: 9 }, (_, i) => ({ input: "Контекст " + i, output: null }));
  review.turns.unshift(...history);
  const result = await f.json<ReviewVerdict>(reviewsPath, review);
  assert.equal(result.classification, "flagged");
  assert.equal(result.severity, 3);
  assert.deepEqual(result.findings.map(({ evidence }) => evidence), [
    { source: "output", quote: "Тема А" }, { source: "input", quote: "мне угрожают" },
  ]);
  assert.deepEqual(result.findings[0].rule, oldRule);
  assert.deepEqual(await f.json(reviewsPath, review), result);
  assert.equal(f.requests.length, 1);
  const [sent] = f.requests;
  assert.equal(sent.model, "openai/gpt-4.1-mini");
  assert.deepEqual(sent.provider, { zdr: true, data_collection: "deny", require_parameters: true });
  assert.equal(sent.response_format.type, "json_schema");
  assert.match(sent.messages[0].content, /Write the description in plain English/);
  assert.match(sent.messages[0].content, /who said what and why it was flagged/);
  assert.deepEqual(JSON.parse(sent.messages[1].content), {
    rules: [oldRule], previousTurns: history, currentTurn: review.turns.at(-1),
  });
  const { items, nextCursor } = await f.json<AlertPage>(alertsPath + "?childId=" + child.id);
  assert.equal(nextCursor, null);
  assert.deepEqual(items, [{
    turnId: review.turnId, childId: child.id, childName: "Майя", occurredAt, question: input,
    seenAt: null, severity: 3, findings: result.findings,
  }]);
  const stored = JSON.stringify(f.db.prepare("SELECT * FROM summary_events").all());
  assert.doesNotMatch(stored, /Остальная реплика|Контекст/);
  assert.equal((await f.json<ChildSummary[]>(childrenPath))[0].unreadAlerts, 1);
  assert.equal((await f.call(childrenPath + "/" + child.id, undefined, "DELETE")).status, 204);
  assert.deepEqual(await f.json(alertsPath), { items: [], nextCursor: null });
});

test("throws away history-only evidence and never stores ordinary turns", async (t) => {
  let result: unknown = { findings: [] };
  const f = fixture(t, () => result);
  const rule = await f.json<Rule>("/api/parent/rules", { label: "Старая тема" }, 201);
  const unused = await f.json<Rule>("/api/parent/rules", { label: "Другая тема" }, 201);
  const child = await f.child("Майя", [rule.id]);
  const grant = await f.start(child);
  const review = payload(child, grant, "Как устроены облака?", "В облаках много капель воды.");
  review.turns.unshift({ input: "Старая тема", output: "Уйдём от темы." });
  assert.deepEqual(await f.json(reviewsPath, review), { classification: "ok", severity: 0, findings: [] });
  assert.deepEqual(await f.json(reviewsPath, review), { classification: "ok", severity: 0, findings: [] });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages[0].content, /Assess only currentTurn/);
  assert.match(f.requests[0].messages[0].content, /after a topic change do not carry over/);

  result = { findings: [{ ...concern("Старая тема"), kind: "forbidden_topic", ruleId: rule.id }] };
  assert.deepEqual(await f.json(reviewsPath, { ...review, turnId: randomUUID() }), {
    classification: "ok", severity: 0, findings: [],
  });
  for (const [ruleId, quote] of [[rule.id, "Нет в тексте"], [unused.id, "облака"]] as const) {
    result = { findings: [{
      ...concern(quote), kind: "forbidden_topic", ruleId,
    }] };
    assert.equal((await f.call(reviewsPath, { ...review, turnId: randomUUID() })).status, 502);
  }
  const other = await f.child("Алекс");
  assert.equal((await f.call(reviewsPath, { ...review, childId: other.id })).status, 404);
  assert.equal((await f.call(reviewsPath, { ...review, turns: Array(11).fill(review.turns[0]) })).status, 400);
  assert.deepEqual(await f.json(alertsPath), { items: [], nextCursor: null });
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM summary_events").get()?.count, 0);
});

test("keeps valid evidence when the provider also returns invalid findings", async (t) => {
  const quote = "мне угрожают";
  const valid = { ...concern(quote), severity: 2 };
  const f = fixture(t, () => ({
    findings: [null, concern("нет такой цитаты"), valid, { ...valid, severity: 5 }],
  }));
  const child = await f.child("Майя");
  const review = payload(child, await f.start(child), quote);
  const result = await f.json<ReviewVerdict>(reviewsPath, review);
  assert.deepEqual(result, {
    classification: "flagged", severity: 2,
    findings: [{ kind: "concern", severity: 2, description: valid.description, evidence: { source: "input", quote } }],
  });
  assert.deepEqual(await f.json(reviewsPath, review), result);
  assert.equal(f.requests.length, 1);
  const { items } = await f.json<AlertPage>(alertsPath);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].findings, result.findings);
});

test("asks OpenRouter to flag discriminatory exclusion by either speaker even when the reply rejects it", async (t) => {
  const exclusion = "Детей другой национальности нельзя пускать в школу.";
  const f = fixture(t, ({ currentTurn: { input, output } }) => {
    if (input === exclusion || output === exclusion) {
      return { findings: [{ ...concern(exclusion, input === exclusion ? "input" : "output"), severity: 2 }] };
    }
    return { findings: [] };
  });
  const child = await f.child("Майя");
  const grant = await f.start(child);
  for (const [input, output, source] of [
    [exclusion, "Все дети имеют право учиться.", "input"],
    ["Расскажи о школе.", exclusion, "output"],
  ]) {
    const result = await f.json<ReviewVerdict>(reviewsPath, payload(child, grant, input, output));
    assert.equal(result.classification, "flagged");
    assert.deepEqual(result.findings[0].evidence, { source, quote: exclusion });
  }
  const neutral = await f.json<ReviewVerdict>(reviewsPath, payload(child, grant, "Что значит хейт-спич?", "Это враждебные высказывания о людях по признаку их принадлежности к группе."));
  assert.equal(neutral.classification, "ok");
  assert.equal((await f.json<AlertPage>(alertsPath)).items.length, 2);

  const rubric = f.requests[0].messages[0].content;
  assert.match(rubric, /flag hate speech or discrimination by either speaker/i);
  assert.match(rubric, /exclusion can qualify without a slur, threat or violence/i);
  assert.match(rubric, /rejects the other speaker's hateful statement/i);
  assert.match(rubric, /neutral questions about hate speech.*should not be flagged on their own/i);
});

test("allows retry after a provider failure and shares in-flight assessment for the same turn", async (t) => {
  let resolveReview: ((value: unknown) => void) | undefined;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture(t, () => {
    if (f.requests.length === 1) return new Response(null, { status: 503 });
    return new Promise((resolve) => { resolveReview = resolve; ready(); });
  });
  const child = await f.child("Майя");
  const review = payload(child, await f.start(child), "мне угрожают");
  assert.equal((await f.call(reviewsPath, review)).status, 502);
  const first = f.json(reviewsPath, review);
  await started;
  const retry = f.json(reviewsPath, review);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resolveReview);
  resolveReview({ findings: [concern("мне угрожают")] });
  assert.deepEqual(await first, await retry);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.json<AlertPage>(alertsPath)).items.length, 1);
});

test("paginates newest first without marking anything read until explicitly requested", async (t) => {
  const f = fixture(t, () => ({ findings: [concern("мне угрожают")] }));
  const first = await f.child("Майя");
  const second = await f.child("Алекс");
  const grant = await f.start(first);
  const otherGrant = await f.start(second);
  const turns = [];
  for (let i = 0; i < 27; i++) {
    const review = i === 0
      ? payload(second, otherGrant, "мне угрожают")
      : payload(first, grant, "мне угрожают");
    review.occurredAt = new Date(Date.parse(occurredAt) + (i < 2 ? 0 : i) * 1000).toISOString();
    await f.json(reviewsPath, review);
    turns.push(review.turnId);
  }
  const counts = async () => (await f.json<ChildSummary[]>(childrenPath)).map(({ displayName, unreadAlerts }) => [displayName, unreadAlerts]);
  assert.deepEqual(await counts(), [["Алекс", 1], ["Майя", 26]]);
  const head = await f.json<AlertPage>(alertsPath);
  assert.deepEqual(head.items.map(({ turnId }) => turnId), turns.slice(2).reverse());
  assert.ok(head.nextCursor);
  const tail = await f.json<AlertPage>(alertsPath + "?cursor=" + encodeURIComponent(head.nextCursor));
  assert.deepEqual(tail.items.map(({ turnId }) => turnId), turns.slice(0, 2).sort().reverse());
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(await counts(), [["Алекс", 1], ["Майя", 26]]);
  assert.equal((await f.call(alertsPath + "/read", { turnIds: turns })).status, 400);
  assert.equal((await f.call(alertsPath + "?cursor=invalid")).status, 400);
  assert.equal((await f.call(alertsPath + "/read", { turnIds: head.items.map(({ turnId }) => turnId) })).status, 204);
  const profileAlerts = await f.json<AlertPage>(alertsPath + "?childId=" + first.id);
  assert.equal(profileAlerts.items.filter(({ seenAt }) => seenAt !== null).length, 25);
  assert.deepEqual(await counts(), [["Алекс", 1], ["Майя", 1]]);
});

test("reports that reviews are unavailable without an OpenRouter key", async (t) => {
  const f = fixture(t, () => assert.fail("Must not call OpenRouter"), "");
  const child = await f.child("Майя");
  assert.equal((await f.call(reviewsPath, payload(child, await f.start(child), "Проверка"))).status, 503);
});

test("writes complete turned-in transcripts and both verdicts only for opted-in local debug", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "voice-lab-debug-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "turn-reviews.jsonl");
  const enabled = { TURN_REVIEW_DEBUG: "1" };
  assert.equal(openTurnDebugLog({}, "127.0.0.1", directory), undefined);
  assert.equal(openTurnDebugLog({ ...enabled, NODE_ENV: "production" }, "127.0.0.1", directory), undefined);
  assert.equal(openTurnDebugLog(enabled, "0.0.0.0", directory), undefined);
  assert.throws(() => statSync(path), { code: "ENOENT" });
  const debugLog = openTurnDebugLog(enabled, "127.0.0.1", directory);
  assert.equal(readFileSync(path, "utf8"), "");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);

  const f = fixture(t, ({ currentTurn }) => currentTurn.output === null
    ? new Response(null, { status: 503 })
    : { findings: [] }, "test-only", debugLog);
  const child = await f.child("Майя");
  const grant = await f.start(child);
  const review = payload(child, grant, "Первая строка\nВторая строка", "Полный ответ\nВторая строка ответа");
  const result = await f.json(reviewsPath, review);
  await f.json(reviewsPath, review);
  const failed = payload(child, grant, "Вопрос с ошибкой проверки");
  assert.equal((await f.call(reviewsPath, failed)).status, 502);
  const [success, failure, ...others] = readFileSync(path, "utf8").trimEnd().split("\n")
    .map((line): TurnDebugEntry => JSON.parse(line));
  assert.equal(success.turnId, review.turnId);
  assert.equal(success.childId, child.id);
  assert.equal(success.conversationId, grant.conversationId);
  assert.equal(success.rulesVersion, child.rulesVersion);
  assert.equal(success.input, review.turns[0].input);
  assert.equal(success.output, review.turns[0].output);
  assert.equal(success.status, 200);
  assert.deepEqual(success.modelVerdict, { findings: [] });
  assert.deepEqual(success.verdict, result);
  assert.equal(failure.turnId, failed.turnId);
  assert.equal(failure.input, failed.turns[0].input);
  assert.equal(failure.output, null);
  assert.equal(failure.status, 502);
  assert.equal(failure.error, "OpenRouter HTTP 503");
  assert.deepEqual(others, []);
});
