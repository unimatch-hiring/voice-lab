/**
 * Вход в админку по коду в Slack.
 *
 * Заменяет общий пароль: интервьюер вводит свою почту, бот присылает ему шесть
 * цифр в личку, он их вводит. Помнить нечего, передавать между людьми нечего,
 * отзывать можно по одному человеку.
 *
 * Список разрешённых лежит в KV, а не в переменной окружения: иначе добавить
 * человека значило бы деплой, а вся затея была в том, чтобы не держать в голове
 * команды.
 */

/** Код живёт десять минут — этого хватает дойти до Slack и обратно. */
const CODE_TTL_SECONDS = 600;
/** Сессия на смену: собес идёт 80 минут, но их бывает несколько подряд. */
const SESSION_TTL_SECONDS = 12 * 3600;
/** Сколько кодов можно запросить на один адрес за окно. */
const CODE_LIMIT = 3;
const CODE_LIMIT_WINDOW = 900;
/** После стольких неверных попыток код сгорает. */
const MAX_TRIES = 5;

const normalise = (email) => String(email ?? "").trim().toLowerCase();

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Шесть цифр из криптографического источника: Math.random предсказуем. */
function sixDigits() {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n % 1_000_000).padStart(6, "0");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Пишет человеку в личку.
 *
 * Токен бота общий с Hermes и умеет больше, чем нужно здесь, поэтому воркер
 * трогает ровно два метода Slack и никаких других.
 */
async function slackDm(env, email, text) {
  const call = async (method, params) => {
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
    });
    return r.json();
  };

  const found = await call("users.lookupByEmail", { email });
  if (!found.ok) return false;
  const sent = await call("chat.postMessage", { channel: found.user.id, text });
  return sent.ok === true;
}

/**
 * Выдаёт код, если адрес в списке.
 *
 * Ответ одинаковый в любом случае. Разные ответы позволили бы за пять минут
 * перебрать, у кого есть админский доступ — утекли бы не пароли, а люди.
 */
export async function requestCode(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const same = () => json({ ok: true });
  if (!email.includes("@")) return same();

  const person = await env.KEYS.get(`admin:${email}`);
  if (!person) return same();

  const rateKey = `otprate:${email}`;
  const used = Number((await env.KEYS.get(rateKey)) ?? 0);
  if (used >= CODE_LIMIT) return same();
  await env.KEYS.put(rateKey, String(used + 1), { expirationTtl: CODE_LIMIT_WINDOW });

  const code = sixDigits();
  // В KV кладём хэш: содержимое хранилища не должно быть достаточным для входа.
  await env.KEYS.put(
    `otp:${email}`,
    JSON.stringify({ hash: await sha256(`${email}:${code}`), tries: 0 }),
    { expirationTtl: CODE_TTL_SECONDS },
  );

  await slackDm(env, email, `Код для админки voice-lab: *${code}*\nДействует 10 минут.`);
  return same();
}

/** Меняет верный код на сессию. Код одноразовый. */
export async function verifyCode(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  const code = String(body.code ?? "").trim();

  const raw = await env.KEYS.get(`otp:${email}`);
  if (!raw) return json({ error: "code expired" }, 401);
  const state = JSON.parse(raw);

  if (state.tries >= MAX_TRIES) {
    await env.KEYS.delete(`otp:${email}`);
    return json({ error: "code expired" }, 401);
  }

  if ((await sha256(`${email}:${code}`)) !== state.hash) {
    await env.KEYS.put(`otp:${email}`, JSON.stringify({ ...state, tries: state.tries + 1 }), {
      expirationTtl: CODE_TTL_SECONDS,
    });
    return json({ error: "wrong code" }, 401);
  }

  await env.KEYS.delete(`otp:${email}`);
  const session = randomToken();
  await env.KEYS.put(`sess:${session}`, email, { expirationTtl: SESSION_TTL_SECONDS });
  return json({ session, email });
}

/** Кто пришёл по этой сессии, или null. */
export async function sessionEmail(req, env) {
  const token = req.headers.get("x-admin-session") ?? "";
  if (!token || !env.KEYS) return null;
  return env.KEYS.get(`sess:${token}`);
}

/** Список людей с доступом — читать и править может только вошедший. */
export async function listPeople(env, json) {
  const { keys } = await env.KEYS.list({ prefix: "admin:" });
  const people = await Promise.all(
    keys.map(async ({ name }) => ({
      email: name.slice("admin:".length),
      name: (await env.KEYS.get(name)) || "",
    })),
  );
  return json({ people });
}

export async function addPerson(req, env, json) {
  const body = await req.json().catch(() => ({}));
  const email = normalise(body.email);
  if (!email.includes("@")) return json({ error: "email required" }, 400);
  await env.KEYS.put(`admin:${email}`, String(body.name ?? "").slice(0, 80));
  return json({ email });
}

export async function removePerson(email, env, json) {
  const key = `admin:${normalise(email)}`;
  if ((await env.KEYS.get(key)) === null) return json({ error: "no such person" }, 404);
  await env.KEYS.delete(key);
  return json({ removed: normalise(email) });
}
