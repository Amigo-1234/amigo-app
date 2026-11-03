/**
 * A World's whole life on a deployed environment, on two phones: it's
 * upcoming (countdown), people join, it goes live on the server's clock with
 * no admin present (status flips without a reload; members get a "live"
 * notice), members post, submit an entry, like and chat (each sees the other's
 * activity), the leaderboard scores it, and when it ends it shows the winner
 * and closes posting and chat.
 *
 * The World itself is created beforehand by the operator (an admin action)
 * and deleted afterwards; its slug comes from WORLD. Temporary accounts only.
 *
 *   BASE=… VERCEL_BYPASS=… WORLD=<slug> node scripts/test/live-worlds.test.mjs
 */
import { randomBytes } from "node:crypto";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, WORLD } = process.env;
if (!BASE || !VERCEL_BYPASS || !WORLD) throw new Error("Set BASE, VERCEL_BYPASS and WORLD");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const host = new URL(BASE).hostname;
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `World Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  return { id: (await res.json()).user.id, email, password, cookies: res.headers.getSetCookie() };
}
async function tokenOf(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return null;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}))).token ?? null;
}
const rest = async (who, path, init = {}) => {
  const token = await tokenOf(who);
  return fetch(`${BASE}/neon/rest/v1/${path}`, { ...init, headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
};

const browser = await chromium.launch();
async function phone(who) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  await ctx.addCookies(
    who.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 20000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  await page.locator(".bottom-create").waitFor();
  return { ctx, page, errors };
}
const pill = (page) => page.locator(".world-hero .world-status").first().innerText().catch(() => "");

const tag = randomBytes(4).toString("hex");
const people = [];
let step = "accounts";
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);

  // World row (start/end) as the server has it.
  const [w] = await (await rest(A, `worlds?slug=eq.${WORLD}&select=id,title,starts_at,ends_at,competition`)).json();
  if (!w) throw new Error("the test World doesn't exist");
  const startsAt = new Date(w.starts_at).getTime();
  const endsAt = new Date(w.ends_at).getTime();

  step = "upcoming + join";
  const a = await phone(A);
  const b = await phone(B);
  await a.page.goto(`${BASE}/worlds/${WORLD}`);
  await a.page.locator(".world-hero__title").waitFor();
  const before = await pill(a.page);
  ok("an upcoming World shows its countdown", /Starts in/.test(before), before);
  await a.page.getByRole("button", { name: `Join ${w.title}` }).click();
  await a.page.getByRole("button", { name: `Joined ${w.title}. Leave` }).waitFor();
  ok("A joins before it starts", true);
  await b.page.goto(`${BASE}/worlds/${WORLD}`);
  await b.page.getByRole("button", { name: `Join ${w.title}` }).click();
  await b.page.getByRole("button", { name: `Joined ${w.title}. Leave` }).waitFor();
  ok("B joins too", true);
  await a.page.getByText(/You're in — you'll be able to post when it starts/).waitFor({ timeout: 10000 }).catch(() => undefined);
  ok("members are told they can post once it starts", await a.page.getByText(/You're in/).isVisible().catch(() => false));

  step = "goes live";
  // No reload, no admin: the page flips on time.
  const waitMs = Math.max(0, startsAt - Date.now()) + 3000;
  console.log(`info waiting ${Math.round(waitMs / 1000)} s for the start`);
  await sleep(waitMs);
  let live = "";
  for (let i = 0; i < 10 && !/Live/.test(live); i++) {
    await sleep(500);
    live = await pill(a.page);
  }
  ok("at the start time the page shows it live without a reload", /Live/.test(live), live);
  // The first app to tick opens it for members (apps tick every few minutes; this one now).
  const tick = await fetch(`${BASE}/api/worlds-tick`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${await tokenOf(B)}` } });
  const tickBody = await tick.json().catch(() => ({}));
  ok("the server opens it when an app checks in (no admin present)", tick.ok && tickBody.started >= 0, JSON.stringify(tickBody));
  const notices = await (await rest(A, `world_notices?select=kind,world_id&world_id=eq.${w.id}`)).json();
  ok("members get a 'live' notice", notices.length === 1 && notices[0].kind === "live", JSON.stringify(notices));
  await a.page.goto(`${BASE}/notifications`);
  ok("…shown in Notifications", await a.page.getByText(`${w.title}`).first().waitFor({ timeout: 15000 }).then(() => true, () => false));

  step = "post, entry, like, chat";
  await a.page.goto(`${BASE}/worlds/${WORLD}`);
  const postText = `World hello ${tag}`;
  await a.page.getByPlaceholder(`Say something in ${w.title}…`).fill(postText);
  await a.page.getByRole("button", { name: "Post", exact: true }).first().click();
  await a.page.locator("article", { hasText: postText }).first().waitFor({ timeout: 30000 });
  ok("a member posts in the live World", true);
  await b.page.goto(`${BASE}/worlds/${WORLD}`);
  ok("the other member sees it", await b.page.locator("article", { hasText: postText }).first().waitFor({ timeout: 30000 }).then(() => true, () => false));

  if (w.competition) {
    await a.page.goto(`${BASE}/worlds/${WORLD}?tab=entries`);
    const entryText = `My entry ${tag}`;
    await a.page.locator(".world-composer textarea").fill(entryText);
    await a.page.getByRole("button", { name: "Submit entry" }).click();
    await a.page.locator("article", { hasText: entryText }).first().waitFor({ timeout: 30000 });
    ok("a member submits a competition entry", true);
    await b.page.goto(`${BASE}/worlds/${WORLD}?tab=entries`);
    const entry = b.page.locator("article", { hasText: entryText }).first();
    await entry.waitFor({ timeout: 30000 });
    await entry.getByRole("button", { name: /^Like/ }).click();
    await sleep(1500);
    await b.page.goto(`${BASE}/worlds/${WORLD}?tab=leaderboard`);
    ok("the leaderboard scores the entry", await b.page.getByText("World Test A").first().waitFor({ timeout: 30000 }).then(() => true, () => false));
  }

  await a.page.goto(`${BASE}/worlds/${WORLD}?tab=chat`);
  await b.page.goto(`${BASE}/worlds/${WORLD}?tab=chat`);
  const chatText = `hi room ${tag}`;
  await a.page.locator("#world-chat-input").fill(chatText);
  await a.page.getByRole("button", { name: "Send" }).click();
  const t0 = Date.now();
  const seen = await b.page.locator(".chat-msg", { hasText: chatText }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  ok("live chat reaches the other member within seconds", seen, seen ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : "not within 20 s");

  step = "ends";
  const endWait = Math.max(0, endsAt - Date.now()) + 3000;
  console.log(`info waiting ${Math.round(endWait / 1000)} s for the end`);
  await sleep(endWait);
  await a.page.goto(`${BASE}/worlds/${WORLD}`);
  await a.page.locator(".world-hero__title").waitFor();
  const ended = await pill(a.page);
  ok("after the end it shows as ended", /Ended/.test(ended), ended);
  // The final leaderboard loads just after the World itself.
  if (w.competition) ok("the winner is shown", await a.page.getByLabel("Winner").getByText("World Test A").first().waitFor({ timeout: 15000 }).then(() => true, () => false));
  ok("no composer once it has ended", !(await a.page.getByPlaceholder(`Say something in ${w.title}…`).isVisible().catch(() => false)));
  ok("no Join button once it has ended", !(await a.page.getByRole("button", { name: /Join|Joined/ }).first().isVisible().catch(() => false)));
  await a.page.goto(`${BASE}/worlds/${WORLD}?tab=chat`);
  ok("chat is closed", await a.page.getByText("Chat has closed.").waitFor({ timeout: 10000 }).then(() => true, () => false));
  const r = await rest(B, "rpc/create_world_post", { method: "POST", body: JSON.stringify({ p_world_id: w.id, p_body: "late" }) });
  ok("the server refuses posts after the end", !r.ok);
  ok("no page errors", a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].slice(0, 2).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL at "${step}": ${String(e.message).split("\n")[0]}`);
} finally {
  await browser.close();
  for (const p of people) {
    const token = await tokenOf(p);
    const d = token
      ? await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) })
      : null;
    console.log(`cleanup: ${d?.ok ? "temporary account deleted" : `NOT deleted (${d?.status ?? "no sign-in"})`}`);
    if (!d?.ok) failures++;
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE WORLDS TESTS PASSED");
process.exit(failures ? 1 : 0);
