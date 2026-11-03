/**
 * Moving to the official address (amigoworld.com.ng) with encrypted messages.
 * Browser storage is per address, so a person who already uses messaging on
 * the old address arrives on the new one as a NEW device. With two temporary
 * accounts (A and B) on an iPhone-sized browser:
 *
 *   on the OLD address: A and B set up messaging; A turns on message backup;
 *   B sends A a message, A reads it →
 *   on the NEW address: A signs in with email + password (the real form) →
 *   Messages is locked ("Confirm it's you"), the conversation can't be read →
 *   "Approve from another device" → A's OLD device is asked "Approve a new
 *   sign-in?" → both show the same emoji → "They match" on both → approved →
 *   the earlier message decrypts on the new address; A sends from the new
 *   address and B and A's old device both read it; B's reply reaches the new
 *   address live. A second, never-approved sign-in on the new address stays
 *   locked out. The server only ever holds ciphertext.
 *
 * Nothing about any real account is touched: both accounts are created here
 * and deleted at the end (devices, keys, backup and messages go with them).
 * The recovery key is held in memory only and never printed.
 *
 *   BASE=https://amigoworld.com.ng OLD=https://amigo-app-one.vercel.app \
 *     VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-device-transition.test.mjs
 */
import { randomBytes } from "node:crypto";
import { chromium, webkit, devices } from "playwright";

const { BASE, OLD, VERCEL_BYPASS, ENGINE = "chromium" } = process.env;
if (!BASE || !OLD || !VERCEL_BYPASS) throw new Error("Set BASE, OLD and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label}${extra ? ` — ${extra}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${OLD}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: OLD, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Move Test ${who.toUpperCase()} ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${OLD}/neon/auth/token`, { headers: { ...BYPASS, origin: OLD, cookie } })).json();
  await sleep(800);
  return { id: body.user.id, token, cookies, email, password };
}
async function freshToken(p) {
  const res = await fetch(`${OLD}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: OLD, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const t = await (await fetch(`${OLD}/neon/auth/token`, { headers: { ...BYPASS, origin: OLD, cookie } })).json().catch(() => ({}));
  if (t.token) p.token = t.token;
  await sleep(800);
}
const api = async (who, path, init = {}) => {
  const res = await fetch(`${OLD}/neon/rest/v1/${path}`, {
    ...init,
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text.slice(0, 200) };
  }
};

const tag = randomBytes(3).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE} · old ${new URL(OLD).host} → new ${new URL(BASE).host}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 12 minutes; stopping");
  failures++;
  void browser.close();
}, 12 * 60_000);

const problems = [];
/** A phone on `origin`, already signed in as `p` (cookies from the API) or signed out. */
async function phone(origin, name, p) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(origin, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  if (p)
    await ctx.addCookies(
      p.cookies.map((raw) => {
        const [pair] = raw.split(";");
        const i = pair.indexOf("=");
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: new URL(origin).hostname, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
      }),
    );
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => !/access control checks|^Load failed$/i.test(e.message) && problems.push(`${name}: ${e.message.slice(0, 160)}`));
  const go = async (path) => {
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    const agree = page.getByRole("button", { name: "I agree" });
    await agree.waitFor({ timeout: 6000 }).catch(() => undefined);
    if (await agree.isVisible().catch(() => false)) {
      await agree.click();
      await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    }
  };
  return { ctx, page, go };
}
const text = async (page, sel = "main") => ((await page.locator(sel).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 240);
const waitFor = (loc, ms) => loc.waitFor({ timeout: ms }).then(() => true, () => false);
const gate = (page) => page.getByRole("heading", { name: "Confirm it's you" });

try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  const aHandle = (await api(A, `profiles?select=username&id=eq.${A.id}`)).data?.[0]?.username;

  // ------------------------------------------------------------ old address
  const oldA = await phone(OLD, "A old", A);
  const oldB = await phone(OLD, "B old", B);
  await oldA.go("/messages");
  await oldB.go("/messages");
  await sleep(4000);
  ok("old address: A's messaging is set up (first device)", !(await gate(oldA.page).isVisible().catch(() => false)), await text(oldA.page));
  ok("old address: B's messaging is set up", !(await gate(oldB.page).isVisible().catch(() => false)), await text(oldB.page));

  // A turns on message backup (a recovery key only A has).
  await oldA.go("/settings/backup");
  await oldA.page.getByRole("button", { name: "Set up backup" }).click();
  await oldA.page.getByRole("button", { name: "Create recovery key" }).click();
  const recovery = ((await oldA.page.locator(".recovery-key").innerText({ timeout: 30000 }).catch(() => "")) || "").trim();
  ok("old address: A sets up message backup (recovery key shown once)", recovery.length > 20, recovery ? "key received (not printed)" : await text(oldA.page));
  await oldA.page.getByText("I've saved my recovery key somewhere safe").click();
  await oldA.page.locator("dialog[open]").getByRole("button", { name: "Done" }).click();
  await sleep(1500);

  // B → A: a message sent before the move.
  const before = `Before the move ${tag}`;
  await oldB.go(`/u/${aHandle}`);
  await oldB.page.getByRole("button", { name: /^Message / }).click();
  await oldB.page.waitForURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30000 });
  const conversation = new URL(oldB.page.url()).pathname;
  await oldB.page.locator("#msg-input").fill(before);
  await oldB.page.getByRole("button", { name: "Send", exact: true }).click();
  ok("old address: B's message is sent", await waitFor(oldB.page.locator(".msg--mine:not(.is-pending)", { hasText: before }), 30000), await text(oldB.page, ".msgs"));
  await oldA.go(conversation);
  ok("old address: A reads it (decrypted on A's first device)", await waitFor(oldA.page.locator(".msg", { hasText: before }), 45000), await text(oldA.page, ".msgs"));
  await sleep(4000); // its key goes to A's backup

  // ------------------------------------------------------------ new address: sign in
  const newA = await phone(BASE, "A new");
  await newA.go("/");
  await newA.page.getByLabel("Email").fill(A.email);
  await newA.page.getByLabel("Password", { exact: true }).fill(A.password);
  await newA.page.locator("form.auth__form").getByRole("button", { name: "Sign in" }).click();
  ok("new address: A signs in with email + password", await waitFor(newA.page.locator(".bottom-create"), 30000), await text(newA.page, "body"));
  const cookies = await newA.ctx.cookies();
  const session = cookies.find((c) => /session/i.test(c.name));
  ok("…the session cookie belongs to the new address only (host-only, Secure, HttpOnly)", !!session && session.domain === new URL(BASE).hostname && session.secure && session.httpOnly, session ? `${session.domain} secure=${session.secure} httpOnly=${session.httpOnly} sameSite=${session.sameSite}` : "none");

  // Locked until approved.
  await newA.go(conversation);
  ok("new address: Messages is locked for the new device (“Confirm it's you”)", await waitFor(gate(newA.page), 30000), await text(newA.page));
  ok("…and the earlier message is not shown", !(await newA.page.getByText(before).count()));
  const approve = newA.page.getByRole("button", { name: "Approve from another device" });
  ok("…“Approve from another device” is offered (A has a device elsewhere)", await waitFor(approve, 10000), await text(newA.page));

  // ------------------------------------------------------------ approval with emoji
  await oldA.go("/messages");
  await approve.click();
  const incoming = oldA.page.getByRole("heading", { name: "Approve a new sign-in?" });
  let asked = await waitFor(incoming, 60000);
  if (!asked) {
    info("old device: no request after 60 s; reopening the app there");
    await oldA.go("/messages");
    asked = await waitFor(incoming, 60000);
  }
  ok("old device is asked “Approve a new sign-in?”", asked, await text(oldA.page, "body"));
  await oldA.page.locator("dialog[open]").getByRole("button", { name: "Continue" }).click();
  const emojiOld = oldA.page.locator(".verify__emoji");
  const emojiNew = newA.page.locator(".verify__emoji");
  const both = (await waitFor(emojiOld, 60000)) && (await waitFor(emojiNew, 60000));
  const eo = both ? (await emojiOld.innerText()).replace(/\s+/g, " ") : "";
  const en = both ? (await emojiNew.innerText()).replace(/\s+/g, " ") : "";
  ok("both devices show the same emoji", both && eo === en && eo.length > 0, both ? eo.slice(0, 80) : "emoji not shown on both");
  await newA.page.locator("dialog[open]").getByRole("button", { name: "They match" }).click();
  await oldA.page.locator("dialog[open]").getByRole("button", { name: "They match" }).click();
  ok("new address: “This device is approved”", await waitFor(newA.page.getByRole("heading", { name: "This device is approved" }), 60000), await text(newA.page, "dialog[open]"));
  await newA.page.locator("dialog[open]").getByRole("button", { name: "Done" }).click().catch(() => undefined);
  await oldA.page.locator("dialog[open]").getByRole("button", { name: /Done|Close/ }).click().catch(() => undefined);

  // ------------------------------------------------------------ messaging on the new address
  await sleep(3000);
  await newA.go(conversation);
  ok("new address: Messages opens (no longer locked)", !(await waitFor(gate(newA.page), 5000)), await text(newA.page));
  ok("new address: the message from before the move decrypts", await waitFor(newA.page.locator(".msg", { hasText: before }), 60000), await text(newA.page, ".msgs"));
  ok("…nothing shown as undecryptable", !(await newA.page.getByText(/can.t be decrypted on this device/i).count()));

  const fromNew = `Sent from the new address ${tag}`;
  await newA.page.locator("#msg-input").fill(fromNew);
  await newA.page.getByRole("button", { name: "Send", exact: true }).click();
  ok("new address: A sends a message", await waitFor(newA.page.locator(".msg--mine:not(.is-pending)", { hasText: fromNew }), 30000), await text(newA.page, ".msgs"));
  await freshToken(A);
  const rows = await api(A, `dm_messages?select=content&order=created_at.desc&limit=5&conversation_id=eq.${conversation.split("/").pop()}`);
  const stored = JSON.stringify(rows.data);
  ok("the server holds ciphertext only", rows.status < 300 && stored.includes("m.megolm.v1.aes-sha2") && !stored.includes(fromNew) && !stored.includes(before), String(rows.status));
  await oldB.go(conversation);
  ok("B (old address) reads it", await waitFor(oldB.page.locator(".msg", { hasText: fromNew }), 45000), await text(oldB.page, ".msgs"));
  await oldA.go(conversation);
  ok("A's old device reads it too", await waitFor(oldA.page.locator(".msg", { hasText: fromNew }), 45000), await text(oldA.page, ".msgs"));

  const reply = `Reply to the new address ${tag}`;
  await oldB.page.locator("#msg-input").fill(reply);
  await oldB.page.getByRole("button", { name: "Send", exact: true }).click();
  ok("B's reply reaches the new address live", await waitFor(newA.page.locator(".msg", { hasText: reply }), 45000), await text(newA.page, ".msgs"));

  // ------------------------------------------------------------ an unapproved sign-in stays locked
  const stranger = await phone(BASE, "A unapproved");
  await stranger.go("/");
  await stranger.page.getByLabel("Email").fill(A.email);
  await stranger.page.getByLabel("Password", { exact: true }).fill(A.password);
  await stranger.page.locator("form.auth__form").getByRole("button", { name: "Sign in" }).click();
  await stranger.page.locator(".bottom-create").waitFor({ timeout: 30000 }).catch(() => undefined);
  await stranger.go(conversation);
  ok("a second, unapproved sign-in on the new address is locked out of Messages", await waitFor(gate(stranger.page), 30000), await text(stranger.page));
  ok("…and can't see any message", !(await stranger.page.getByText(before).count()) && !(await stranger.page.getByText(fromNew).count()));

  ok("no uncaught errors", !problems.length, problems.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  for (const p of people) {
    await freshToken(p).catch(() => undefined);
    const d = await fetch(`${OLD}/neon/rest/v1/rpc/delete_my_account`, {
      method: "POST",
      headers: { ...BYPASS, authorization: `Bearer ${p.token}`, "content-type": "application/json" },
      body: JSON.stringify({ p_confirm: "DELETE" }),
    }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status}) id=${p.id}`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL DEVICE TRANSITION TESTS PASSED");
process.exit(failures ? 1 : 0);
