/**
 * Creator Programme on a deployed environment while applications are CLOSED
 * (the shared database's setting; opening them is the owner's call): the
 * Settings entry and screen (status, early-access notice, closed state, no
 * payment UI), and the database's refusals for a normal member — applying,
 * feedback, every admin action, and direct table access. The full workflow
 * (apply → review → approve → dashboard → feedback) runs against a local
 * database in scripts/test/creator-programme.test.mjs.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-creator.test.mjs
 */
import { randomBytes } from "node:crypto";
import { chromium, webkit, devices } from "playwright";

const { BASE, VERCEL_BYPASS, ENGINE = "chromium" } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `amigo-e2e-${randomBytes(4).toString("hex")}-creator@example.com`;
const password = randomBytes(18).toString("base64url");
const me = {};
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/neon/rest/v1/${path}`, { ...init, headers: { ...BYPASS, authorization: `Bearer ${me.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, code: data?.code };
};
const rpc = (fn, args = {}) => api(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
async function signIn(path, body) {
  const res = await fetch(`${BASE}/neon/auth/${path}`, { method: "POST", headers: { ...BYPASS, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  me.cookies = res.headers.getSetCookie();
  const cookie = me.cookies.map((c) => c.split(";")[0]).join("; ");
  me.token = (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json()).token;
  await sleep(800);
  return res;
}
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
try {
  const res = await signIn("sign-up/email", { email, password, name: "Creator Test" });
  me.id = (await res.json()).user.id;

  let r = await rpc("my_creator_programme");
  ok("the programme overview loads", r.status === 200 && r.data?.creator_status === "not_eligible", JSON.stringify(r.data).slice(0, 120));
  const open = !!r.data?.applications_open;
  console.log(`info applications are ${open ? "OPEN" : "closed"} on this database`);
  if (!open) {
    r = await rpc("creator_apply", { p_category: "music", p_description: "I write songs every single week.", p_reason: "I want feedback and an audience for them.", p_links: [], p_extra: "" });
    ok("applying while closed is refused", r.code === "MN001", r.code);
  }
  r = await rpc("creator_feedback_submit", { p_category: "features", p_rating: 5, p_body: "Not a member, should be refused." });
  ok("feedback from a non-member is refused", r.code === "CP010", r.code);
  for (const [fn, args] of [
    ["admin_creator_applications_v2", { p_status: "all", p_query: "" }],
    ["admin_creator_application_decide", { p_application: me.id, p_decision: "approved", p_note: "" }],
    ["admin_creator_feedback", { p_status: "all" }],
    ["admin_creator_feedback_update", { p_feedback: me.id, p_status: "resolved", p_response: "x" }],
    ["admin_creator_stats", { p_user: me.id }],
    ["admin_monetization_status_set", { p_user: me.id, p_status: "eligible", p_reason: "self-approve" }],
    ["admin_monetization_settings_set", { p_programme_open: true, p_applications_open: true, p_criteria: {}, p_public_note: "" }],
  ]) {
    r = await rpc(fn, args);
    ok(`a member calling ${fn} is refused`, r.code === "42501", r.code);
  }
  r = await rpc("creator_stats", { p_user: me.id });
  ok("the internal stats function can't be called directly", r.status >= 400, String(r.status));
  for (const t of ["creator_applications", "creator_feedback", "creator_monetization_status"]) {
    r = await api(`${t}?select=*`);
    ok(`no direct read of ${t}`, r.status >= 400, String(r.status));
  }
  r = await api("creator_monetization_status", { method: "POST", body: JSON.stringify({ user_id: me.id, status: "eligible" }) });
  ok("can't make yourself a creator directly", r.status >= 400, String(r.status));

  // The screen.
  const host = new URL(BASE).hostname;
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(me.cookies.map((raw) => {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
  }));
  await ctx.addInitScript(() => {
    const hide = () => {
      const st = document.createElement("style");
      st.textContent = "vercel-live-feedback{display:none!important}";
      document.documentElement.appendChild(st);
    };
    if (document.documentElement) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  }
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  const entry = page.getByRole("link", { name: /Creator Monetization/ });
  ok("Settings shows Creator Monetization", await entry.isVisible().catch(() => false));
  await entry.click();
  await page.getByText("Your creativity deserves opportunities.").waitFor().catch(() => undefined);
  ok("intro and early-access notice", await page.getByText(/Approval does not guarantee earnings, and payments are not available yet/).isVisible().catch(() => false));
  ok("status: Not applied", await page.getByText("Not applied", { exact: true }).isVisible().catch(() => false));
  if (!open) ok("closed state explained, no form", (await page.getByText(/Applications aren't open right now/).isVisible().catch(() => false)) && (await page.getByRole("button", { name: "Submit application" }).count()) === 0);
  ok("no wallet, balance or payout UI", (await page.getByText(/wallet|balance|payout|withdraw funds/i).count()) === 0);
  ok("no horizontal overflow", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  ok("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  await browser.close().catch(() => undefined);
  try {
    await signIn("sign-in/email", { email, password });
    const d = await rpc("delete_my_account", { p_confirm: "DELETE" });
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status})`}`);
  } catch (e) {
    failures++;
    console.log(`cleanup failed: ${e.message}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE CREATOR TESTS PASSED");
process.exit(failures ? 1 : 0);
