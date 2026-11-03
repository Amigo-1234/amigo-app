/**
 * Messaging latency benchmark against the live Neon project, using the app's
 * own messaging code (src/data/supabase/messages.ts, Neon mode, real crypto).
 *
 *   NEON_AUTH_URL=… NEON_DATA_API_URL=… APP_ORIGIN=… node scripts/test/neon-perf.mjs
 *
 * Measures, for N messages each way between two fresh accounts:
 *   - send: time until the message is stored (what the sender waited for
 *     before optimistic UI), network calls per send, time in network vs local
 *   - delivery: stored -> visible in the other person's open conversation,
 *     with the app's real polling (liveQuery semantics)
 *   - raw round trip of one small Data API call (warm), and the first call
 *     (cold if the compute was suspended)
 * Both accounts are deleted at the end when Neon Auth allows it.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const { NEON_AUTH_URL, NEON_DATA_API_URL, APP_ORIGIN } = process.env;
if (!NEON_AUTH_URL || !NEON_DATA_API_URL || !APP_ORIGIN) throw new Error("Set NEON_AUTH_URL, NEON_DATA_API_URL and APP_ORIGIN");
const N = Number(process.env.N ?? 8);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(q(0.5)), p90: Math.round(q(0.9)), max: Math.round(s.at(-1)), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function auth(path, body, cookie) {
  const res = await fetch(`${NEON_AUTH_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: APP_ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return { json, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") || cookie };
}

/** Data API client whose fetch counts calls and network time. */
function meteredClient(token) {
  const meter = { calls: 0, ms: 0 };
  const fetchMetered = async (url, init) => {
    const t = performance.now();
    try {
      return await fetch(url, init);
    } finally {
      meter.calls++;
      meter.ms += performance.now() - t;
    }
  };
  const base = NEON_DATA_API_URL.replace(/\/rest\/v1\/?$/, "");
  const db = createClient(base, "neon", { auth: { persistSession: false }, global: { fetch: fetchMetered, headers: { Authorization: `Bearer ${token}` } } });
  return { db, meter };
}

async function account(tag, who) {
  const email = `amigo-perf-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const { json, cookie } = await auth("/sign-up/email", { email, password, name: `Perf ${who} ${tag}` });
  const { json: tok } = await auth("/token", null, cookie);
  return { id: json.user.id, cookie, password, ...meteredClient(tok.token) };
}

// The app's live-query semantics on Neon: fetch now, refetch on local writes and on the poll interval.
function makeLiveQuery() {
  const invalidators = new Set();
  const liveQuery = (_name, fetcher, sub, _listen, pollMs = 30_000) => {
    let active = true;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) return void (again = true);
      running = true;
      try {
        const v = await fetcher();
        if (active) sub.onData(v);
      } catch (e) {
        if (active) sub.onError(e);
      } finally {
        running = false;
        if (again && active) {
          again = false;
          void run();
        }
      }
    };
    void run();
    const timer = setInterval(run, pollMs);
    invalidators.add(run);
    return () => {
      active = false;
      clearInterval(timer);
      invalidators.delete(run);
    };
  };
  return { liveQuery, invalidate: () => invalidators.forEach((f) => f()) };
}

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");

const tag = randomBytes(3).toString("hex");
const report = {};
let A, B;
try {
  // Raw round trips: the first call may hit a suspended (cold) compute.
  A = await account(tag, "a");
  B = await account(tag, "b");
  const rtts = [];
  for (let i = 0; i < 8; i++) {
    const t = performance.now();
    await A.db.from("profiles").select("id").eq("id", A.id);
    rtts.push(performance.now() - t);
  }
  report.firstCallMs = Math.round(rtts[0]);
  report.warmRoundTrip = stats(rtts.slice(2));

  const lqA = makeLiveQuery();
  const lqB = makeLiveQuery();
  const appA = createSupabaseMessages(A.db, lqA.liveQuery, lqA.invalidate, { memoryStore: true, realtime: false });
  const appB = createSupabaseMessages(B.db, lqB.liveQuery, lqB.invalidate, { memoryStore: true, realtime: false });
  let t = performance.now();
  await Promise.all([appA.security.setup(A.id), appB.security.setup(B.id)]);
  report.deviceSetupMs = Math.round(performance.now() - t);
  const conv = await appA.openConversation(A.id, B.id);

  // Both people have the conversation open (the app's real polling).
  const seen = { [A.id]: new Map(), [B.id]: new Map() };
  const watch = (app, me) =>
    app.subscribeConversation(conv, me, {
      onData: (v) => {
        for (const m of v?.messages ?? []) if (!m.fromViewer && m.text && !seen[me].has(m.text)) seen[me].set(m.text, performance.now());
      },
      onError: () => {},
    });
  const stopA = watch(appA, A.id);
  const stopB = watch(appB, B.id);
  await new Promise((r) => setTimeout(r, 1500));

  const send = [], calls = [], netMs = [], deliver = [];
  for (let i = 0; i < N; i++) {
    const [from, to, sender, recipient] = i % 2 ? [B, A, appB, A.id] : [A, B, appA, B.id];
    const text = `perf ${tag} ${i} ${randomBytes(4).toString("hex")}`;
    const before = { ...from.meter };
    const t0 = performance.now();
    await sender.send(from.id, conv, { text });
    const stored = performance.now();
    send.push(stored - t0);
    calls.push(from.meter.calls - before.calls);
    netMs.push(from.meter.ms - before.ms);
    while (!seen[recipient].has(text) && performance.now() - stored < 30_000) await new Promise((r) => setTimeout(r, 25));
    deliver.push((seen[recipient].get(text) ?? Infinity) - stored);
    void to;
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
  }
  stopA();
  stopB();
  report.send = stats(send);
  report.networkCallsPerSend = stats(calls);
  report.networkMsPerSend = stats(netMs);
  report.localMsPerSend = stats(send.map((s, i) => s - netMs[i]));
  report.delivery = stats(deliver);

  // Background load while idle with a conversation open: requests per minute per person.
  const idle0 = A.meter.calls;
  const stop = watch(appA, A.id);
  await new Promise((r) => setTimeout(r, 20_000));
  stop();
  report.idleRequestsPerMinute = Math.round(((A.meter.calls - idle0) / 20) * 60);
} catch (e) {
  report.error = String(e.stack ?? e);
} finally {
  for (const X of [A, B].filter(Boolean)) {
    const r = await fetch(`${NEON_AUTH_URL}/delete-user`, { method: "POST", headers: { origin: APP_ORIGIN, cookie: X.cookie, "content-type": "application/json" }, body: JSON.stringify({ password: X.password }) }).catch(() => null);
    report.cleanup = (report.cleanup ?? "") + `${r?.status ?? "err"} `;
  }
  await vite.close();
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
