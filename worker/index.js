const ALLOWED_ORIGINS = new Set([
  "https://joyzh1029.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const MARKS_KEY = "marks";
const SESSION_TTL = 180 * 24 * 60 * 60; // 180 days
const FAIL_TTL = 15 * 60;
const FAIL_LIMIT = 10;
const MAX_BODY = 200_000;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

function xorDiff(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff;
}

async function passcodeOk(input, secret) {
  if (typeof input !== "string" || typeof secret !== "string" || !secret) return false;
  const a = await sha256("v1:" + input);
  const b = await sha256("v1:" + secret);
  return xorDiff(a, b) === 0;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function tooManyFailures(env, ip) {
  const n = Number((await env.BOOKLIST_KV.get("fail:" + ip)) || "0");
  return n >= FAIL_LIMIT;
}

async function recordFailure(env, ip) {
  const key = "fail:" + ip;
  const n = Number((await env.BOOKLIST_KV.get(key)) || "0") + 1;
  await env.BOOKLIST_KV.put(key, String(n), { expirationTtl: FAIL_TTL });
}

async function clearFailures(env, ip) {
  await env.BOOKLIST_KV.delete("fail:" + ip);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readBearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return m ? m[1].toLowerCase() : "";
}

async function requireSession(request, env) {
  const token = readBearer(request);
  if (!token) return false;
  const row = await env.BOOKLIST_KV.get("sess:" + token);
  return !!row;
}

function isPlainMarks(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function pickMark(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const at = typeof left.updatedAt === "number" ? left.updatedAt : 0;
  const bt = typeof right.updatedAt === "number" ? right.updatedAt : 0;
  if (bt !== at) return bt > at ? { ...right } : { ...left };
  const completedAt =
    left.completedAt && right.completedAt
      ? left.completedAt <= right.completedAt
        ? left.completedAt
        : right.completedAt
      : left.completedAt || right.completedAt;
  return {
    ...left,
    ...right,
    read: !!(left.read || right.read),
    rating: Math.max(Number(left.rating) || 0, Number(right.rating) || 0),
    completedAt,
    updatedAt: Math.max(at, bt) || undefined,
    quizScore: right.quizScore ?? left.quizScore,
    quizTotal: right.quizTotal ?? left.quizTotal,
    quizPassed: right.quizPassed ?? left.quizPassed,
    quizPoints: right.quizPoints ?? left.quizPoints,
    quizAttempts: right.quizAttempts ?? left.quizAttempts,
    quizLastAt: right.quizLastAt ?? left.quizLastAt,
  };
}

function mergeMarks(serverMarks, clientMarks) {
  const out = { ...(isPlainMarks(serverMarks) ? serverMarks : {}) };
  const incoming = isPlainMarks(clientMarks) ? clientMarks : {};
  for (const id of Object.keys(incoming)) {
    out[id] = out[id] ? pickMark(out[id], incoming[id]) : incoming[id];
  }
  return out;
}

async function readMarks(env) {
  const raw = await env.BOOKLIST_KV.get(MARKS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainMarks(parsed && parsed.marks) ? parsed.marks : isPlainMarks(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMarks(env, marks) {
  await env.BOOKLIST_KV.put(MARKS_KEY, JSON.stringify({ marks, updatedAt: Date.now() }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin") || "";
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403, headers: corsHeaders(request) });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health" && request.method === "GET") {
        return json(request, { ok: true });
      }

      if (path === "/login" && request.method === "POST") {
        if (!env.BOOKLIST_PASSCODE) {
          return json(request, { ok: false, error: "服务尚未配置密码" }, 500);
        }
        const ip = clientIp(request);
        if (await tooManyFailures(env, ip)) {
          return json(request, { ok: false, error: "尝试次数过多，请稍后再试" }, 429);
        }
        const len = Number(request.headers.get("Content-Length") || "0");
        if (len > MAX_BODY) return json(request, { ok: false, error: "请求过大" }, 413);
        let body;
        try {
          body = await request.json();
        } catch {
          return json(request, { ok: false, error: "格式不正确" }, 400);
        }
        const passcode = typeof body.passcode === "string" ? body.passcode : "";
        if (!(await passcodeOk(passcode, env.BOOKLIST_PASSCODE))) {
          await recordFailure(env, ip);
          return json(request, { ok: false, error: "密码不正确" }, 401);
        }
        await clearFailures(env, ip);
        const token = randomToken();
        await env.BOOKLIST_KV.put("sess:" + token, "1", { expirationTtl: SESSION_TTL });
        return json(request, { ok: true, token });
      }

      if (path === "/logout" && request.method === "POST") {
        const token = readBearer(request);
        if (token) await env.BOOKLIST_KV.delete("sess:" + token);
        return json(request, { ok: true });
      }

      if (path === "/marks" && (request.method === "GET" || request.method === "PUT")) {
        if (!(await requireSession(request, env))) {
          return json(request, { ok: false, error: "请先输入家庭密码" }, 401);
        }
        if (request.method === "GET") {
          return json(request, { ok: true, marks: await readMarks(env) });
        }
        const len = Number(request.headers.get("Content-Length") || "0");
        if (len > MAX_BODY) return json(request, { ok: false, error: "请求过大" }, 413);
        let body;
        try {
          body = await request.json();
        } catch {
          return json(request, { ok: false, error: "格式不正确" }, 400);
        }
        const merged = mergeMarks(await readMarks(env), body && body.marks);
        await writeMarks(env, merged);
        return json(request, { ok: true, marks: merged });
      }

      return json(request, { ok: false, error: "未找到" }, 404);
    } catch {
      return json(request, { ok: false, error: "服务器出错" }, 500);
    }
  },
};
