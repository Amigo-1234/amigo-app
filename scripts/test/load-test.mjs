/**
 * Bounded load test against a deployed environment (real Neon Data API + Auth).
 * Simulates people using the app: feed reads, profile visits, notifications and
 * inbox reads, likes, the occasional text post, plus each person's background
 * polling. Only temporary accounts are used and deleted at the end; real
 * people's data is read the way any member would see it, never changed.
 *
 *   BASE=… VERCEL_BYPASS=… LEVELS=10,25,50,100 DURATION=60 node scripts/test/load-test.mjs
 *
 * A level runs only if the previous one stayed healthy (p95 < 1.5 s, errors < 1 %).
 */
import { randomBytes, randomUUID } from "node:crypto";

const { BASE, VERCEL_BYPASS, LEVELS = "10,25,50,100", DURATION = "60" } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const REST = "https://ep-dry-mode-zano9y8g.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1";
const levels = LEVELS.split(",").map(Number);
const seconds = Number(DURATION);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

// ------------------------------------------------------------------ accounts

async function signUp(tag, i) {
  const email = `amigo-e2e-${tag}-load${i}@example.com`;
  const password = randomBytes(18).toString("base64url");
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
      method: "POST",
      headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: `Load Test ${i}` }),
    });
    if (res.ok) {
      const body = await res.json();
      const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return { id: body.user.id, email, password, cookie, token: await tokenFor(cookie) };
    }
    // Auth rate limits sign-ups from one address: wait and try again.
    await sleep(res.status === 429 ? 5000 : 1500 * (attempt + 1));
  }
  throw new Error(`sign-up ${i} failed`);
}
async function tokenFor(cookie) {
  const t = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  return t.token;
}
async function signInAgain(p) {
  let res;
  for (let attempt = 0; attempt < 12; attempt++) {
    res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
      method: "POST",
      headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email: p.email, password: p.password }),
    });
    if (res.status !== 429) break;
    await sleep(5000);
  }
  if (!res.ok) return false;
  p.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  p.token = await tokenFor(p.cookie);
  return true;
}

// ------------------------------------------------------------------ requests

let stats;
const resetStats = () => (stats = { lat: {}, all: [], errors: {}, n: 0, failed: 0 });

async function call(who, label, path, init = {}) {
  const t0 = performance.now();
  let ok = false;
  let status = 0;
  try {
    const res = await fetch(`${REST}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json", origin: BASE, ...(init.headers ?? {}) },
    });
    status = res.status;
    await res.arrayBuffer();
    ok = res.ok;
    if (status === 401) {
      // Token expired during the run (they last ~15 min): refresh once, like the app does.
      who.token = await tokenFor(who.cookie);
    }
  } catch {
    status = 0;
  }
  const ms = performance.now() - t0;
  stats.n++;
  (stats.lat[label] ??= []).push(ms);
  stats.all.push(ms);
  if (!ok) {
    stats.failed++;
    stats.errors[`${label} ${status}`] = (stats.errors[`${label} ${status}`] ?? 0) + 1;
  }
}
const rpc = (who, label, fn, args = {}, select = "") =>
  call(who, label, `rpc/${fn}${select ? `?select=${encodeURIComponent(select)}` : ""}`, { method: "POST", body: JSON.stringify(args) });

const POST_SELECT =
  "id,body,created_at,like_count,reply_count,parent_id,is_entry,edited_at,liked,world:worlds!posts_world_id_fkey(slug,title)," +
  "author:profiles!posts_author_id_fkey(id,username,display_name,avatar_url),media:post_media(kind,bucket,storage_path,width,height,alt,position),saved:post_bookmarks(user_id)";

/** One simulated person until `until`. */
async function person(who, until, handles, postIds) {
  let nextPoll = Date.now();
  while (Date.now() < until) {
    // Background polling an open app does (badge/notifications), every ~15 s.
    if (Date.now() >= nextPoll) {
      await rpc(who, "poll unread_notification_count", "unread_notification_count");
      nextPoll = Date.now() + 15_000;
    }
    const r = Math.random();
    if (r < 0.4) await rpc(who, "feed_posts (15)", "feed_posts", { p_scope: "latest", p_limit: 16 }, POST_SELECT);
    else if (r < 0.55) {
      const h = handles[Math.floor(Math.random() * handles.length)];
      await call(who, "profile by handle", `profiles?select=id,username,display_name,avatar_url,bio,created_at&username=ilike.${encodeURIComponent(h)}&limit=1`);
    } else if (r < 0.65) await call(who, "notifications", "notifications?select=id,kind,created_at,read_at&order=created_at.desc&limit=30");
    else if (r < 0.75) await rpc(who, "dm_inbox", "dm_inbox");
    else if (r < 0.85) await rpc(who, "moments_feed", "moments_feed");
    else if (r < 0.95 && postIds.length) {
      const id = postIds[Math.floor(Math.random() * postIds.length)];
      await rpc(who, "set_post_like", "set_post_like", { p_post_id: id, p_liked: Math.random() < 0.5 });
    } else await rpc(who, "create_post", "create_post", { p_body: `load test ${randomUUID().slice(0, 8)}`, p_client_ref: randomUUID() });
    await sleep(2000 + Math.random() * 3000);
  }
}

// ------------------------------------------------------------------ run

const tag = randomBytes(3).toString("hex");
const people = [];
const report = { base: BASE, seconds, levels: [] };
try {
  const needed = Math.max(...levels);
  for (let i = 0; i < needed; i++) {
    people.push(await signUp(tag, i));
    await sleep(150);
  }
  console.log(`accounts ready: ${people.length}`);
  // Each test account writes one post others can like; profiles to visit include the test accounts' own.
  const handles = [];
  const postIds = [];
  for (const p of people.slice(0, 10)) {
    const res = await fetch(`${REST}/rpc/create_post`, { method: "POST", headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify({ p_body: `load seed ${tag}` }) });
    if (res.ok) postIds.push((await res.json()).id);
    const prof = await (await fetch(`${REST}/profiles?select=username&id=eq.${p.id}`, { headers: { authorization: `Bearer ${p.token}` } })).json();
    if (prof[0]) handles.push(prof[0].username);
  }

  let healthy = true;
  for (const n of levels) {
    if (!healthy) {
      report.levels.push({ users: n, skipped: "previous level was not healthy" });
      continue;
    }
    resetStats();
    const until = Date.now() + seconds * 1000;
    const t0 = Date.now();
    await Promise.all(people.slice(0, n).map((p, i) => sleep((i / n) * 3000).then(() => person(p, until, handles, postIds))));
    const elapsed = (Date.now() - t0) / 1000;
    const byEndpoint = Object.fromEntries(
      Object.entries(stats.lat).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p95: pct(v, 95) }]),
    );
    const level = {
      users: n,
      requests: stats.n,
      throughputPerSec: Math.round((stats.n / elapsed) * 10) / 10,
      p50: pct(stats.all, 50),
      p95: pct(stats.all, 95),
      p99: pct(stats.all, 99),
      errorRate: stats.n ? Math.round((stats.failed / stats.n) * 10000) / 100 : null,
      errors: stats.errors,
      byEndpoint,
    };
    report.levels.push(level);
    console.log(`LEVEL ${JSON.stringify(level)}`);
    healthy = level.p95 < 1500 && level.errorRate < 1;
    await sleep(10_000); // let the database settle between levels
  }
} catch (e) {
  report.error = String(e.message).split("\n")[0];
  console.error("error:", report.error);
} finally {
  let deleted = 0;
  for (const p of people) {
    if (!(await signInAgain(p))) continue;
    const d = await fetch(`${REST}/rpc/delete_my_account`, { method: "POST", headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) });
    if (d.ok) deleted++;
    else console.log(`cleanup: NOT deleted id=${p.id} (${d.status})`);
  }
  report.cleanup = { created: people.length, deleted };
  console.log(`cleanup: ${deleted}/${people.length} temporary accounts deleted`);
  console.log(`SUMMARY ${JSON.stringify(report)}`);
}
