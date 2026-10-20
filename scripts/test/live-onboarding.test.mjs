/**
 * Joining Amigo through the real sign-up form on an iPhone-sized browser
 * (Chromium or WebKit), signed out to start:
 *
 *   Create account (email) → "Check your email" with six code boxes (a code is
 *   sent automatically; the resend button counts down; a wrong code is refused)
 *   → Confirm later → interests (multi-select, saved to the account) → a
 *   refresh resumes at the same step → Back returns to the interests → profile
 *   (username check, bio counter) → welcome → Start exploring → Home, and the
 *   steps don't come back. Also: "Continue with Google" is offered.
 *
 * The emailed code itself can't be read here (example.com), so the code is
 * never confirmed; the account stays unverified. It is deleted at the end.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-onboarding.test.mjs
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

const tag = randomBytes(3).toString("hex");
const email = `amigo-e2e-${tag}-onb@example.com`;
const password = randomBytes(18).toString("base64url");
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 8 minutes; stopping");
  failures++;
  void browser.close();
}, 8 * 60_000);
let created = false;

try {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
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
  const problems = [];
  page.on("pageerror", (e) => !/access control checks|^Load failed$/i.test(e.message) && problems.push(e.message.slice(0, 160)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // ------------------------------------------------------------ Google, misconfigured
  // If the provider isn't set up (or refuses), the button must explain, not break the screen.
  await page.route(/\/neon\/auth\/sign-in\/social/, (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "PROVIDER_NOT_FOUND", message: "Provider not found" }) }));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  const googleError = await page.locator(".auth__error, [role=alert]").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  ok("Google sign-in that the provider refuses shows a message (no crash, still on the sign-in screen)", googleError && (await page.getByRole("button", { name: "Continue with Google" }).isVisible()), (await page.locator(".auth__error, [role=alert]").first().textContent().catch(() => "")) ?? "");
  await page.unroute(/\/neon\/auth\/sign-in\/social/);

  // ------------------------------------------------------------ create account
  await page.getByRole("button", { name: "Create account" }).first().click();
  ok("“Continue with Google” is offered", await page.getByRole("button", { name: "Continue with Google" }).isVisible().catch(() => false));
  await page.getByLabel("Name").fill(`Onboarding ${tag}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  for (const box of await page.locator(".auth-consent input[type=checkbox]").all()) await box.check();
  await page.locator("form.auth__form").getByRole("button", { name: "Create account" }).click();
  created = true;

  // ------------------------------------------------------------ verify
  // A fresh account may first be asked to accept the current terms (LegalGate).
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  const verify = page.getByRole("heading", { name: "Check your email" });
  ok("after sign-up: “Check your email” with the code boxes", await verify.waitFor({ timeout: 30000 }).then(() => true, () => false));
  ok("…six boxes", (await page.locator(".onb-code__box").count()) === 6);
  ok("…the code input supports the phone's autofill (one-time-code)", (await page.locator(".onb-code__input").getAttribute("autocomplete")) === "one-time-code");
  const resend = page.getByRole("button", { name: /Send a new code/ });
  ok("…a code was sent and resending counts down", /in \d+s/.test((await resend.textContent()) ?? ""), (await resend.textContent()) ?? "");
  await page.locator(".onb-code__input").fill("000000");
  ok("…a wrong code is refused with a message", await page.locator(".onb__error").waitFor({ timeout: 15000 }).then(() => true, () => false), (await page.locator(".onb__error").textContent().catch(() => "")) ?? "");
  await page.getByRole("button", { name: "Didn't get it?" }).click();
  ok("…“Didn't get it?” explains spam folders and resending", await page.getByText(/Spam/).first().isVisible());
  await page.getByRole("button", { name: "Confirm later" }).click();

  // ------------------------------------------------------------ interests
  ok("interests step", await page.getByRole("heading", { name: "What are you into?" }).waitFor().then(() => true, () => false));
  for (const name of ["Music", "Football", "Photography"]) await page.getByRole("button", { name, exact: true }).click();
  ok("…three picked", (await page.locator(".onb-interest.is-on").count()) === 3);
  await page.getByRole("button", { name: "Continue with 3" }).click();
  ok("profile step", await page.getByRole("heading", { name: "Make it yours" }).waitFor().then(() => true, () => false));

  // A refresh resumes where you were.
  await page.reload({ waitUntil: "networkidle" });
  ok("a refresh resumes at the same step", await page.getByRole("heading", { name: "Make it yours" }).waitFor({ timeout: 20000 }).then(() => true, () => false));
  // Back goes back one step, with the choices kept.
  await page.goBack();
  const backToInterests = await page.getByRole("heading", { name: "What are you into?" }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  ok("Back returns to the interests, still picked", backToInterests && (await page.locator(".onb-interest.is-on").count()) === 3);
  if (backToInterests) await page.getByRole("button", { name: "Continue with 3" }).click();

  // ------------------------------------------------------------ profile
  await page.getByRole("heading", { name: "Make it yours" }).waitFor();
  ok("…your interests are shown for review", (await page.locator(".onb-chip").count()) >= 3);
  const handle = page.getByLabel("Username");
  await handle.fill("ab");
  ok("…a too-short username is explained", await page.getByText(/3–24 characters/).isVisible());
  await handle.fill(`onb_${tag}`);
  ok("…a free username is confirmed", await page.getByText("Available").waitFor({ timeout: 10000 }).then(() => true, () => false));
  await page.getByLabel(/Bio/).fill("Hello from the onboarding test");
  ok("…the bio counter counts down", /\d+ left/.test((await page.locator(".field__count").first().textContent()) ?? ""));
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // ------------------------------------------------------------ welcome
  ok("welcome", await page.getByRole("heading", { name: /Welcome to Amigo World/ }).waitFor({ timeout: 20000 }).then(() => true, () => false));
  ok("…with first things to do", (await page.locator(".onb-action").count()) >= 3);
  await page.getByRole("button", { name: "Start exploring" }).click();
  ok("Start exploring opens Home", await page.locator(".bottom-create").waitFor({ timeout: 20000 }).then(() => true, () => false));
  await page.reload({ waitUntil: "networkidle" });
  ok("the steps don't come back afterwards", !(await page.locator(".onb").count()));

  // Saved to the account.
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  const chips = await page.locator(".settings-chip[aria-pressed=true]").allTextContents();
  ok("interests are saved to the account (Settings shows them)", ["Music", "Football", "Photography"].every((n) => chips.includes(n)), chips.join(", "));
  await page.goto(`${BASE}/u/onb_${tag}`, { waitUntil: "networkidle" });
  ok("the new username and bio are saved", await page.getByText("Hello from the onboarding test").isVisible().catch(() => false));
  ok("no uncaught errors", !problems.length, problems.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  if (created) {
    const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
      method: "POST",
      headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}));
    await sleep(800);
    const d = token
      ? await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) })
      : { status: 0 };
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status})`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL ONBOARDING TESTS PASSED");
process.exit(failures ? 1 : 0);
