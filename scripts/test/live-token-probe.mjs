/**
 * How soon a freshly issued sign-in token is honoured by the database.
 *
 * Sends an empty post (always refused, so nothing is created) right after a
 * token is issued and at intervals after. The refusal says who the database
 * saw: "not signed in" (42501) means the token wasn't honoured; "a post needs
 * text or media" (22023) means it was. Also compares the token's issue time
 * with the database server's clock, and whether each session read issues a
 * new token. One temporary account, deleted at the end. Prints no tokens.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… node scripts/test/live-token-probe.mjs
 */
import { randomBytes } from "node:crypto";

const { BASE, VERCEL_BYPASS } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const claims = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

const email = `amigo-e2e-${randomBytes(4).toString("hex")}-probe@example.com`;
const password = randomBytes(18).toString("base64url");
const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
  method: "POST",
  headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
  body: JSON.stringify({ email, password, name: "Token Probe" }),
});
if (!res.ok) throw new Error(`sign-up ${res.status}`);
const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const newToken = async () => (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json()).token;
const probe = async (token) => {
  const r = await fetch(`${BASE}/neon/rest/v1/rpc/create_post`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ p_body: "", p_media: [] }),
  });
  const body = await r.json().catch(() => ({}));
  const server = Date.parse(r.headers.get("date") ?? "");
  return { seen: body.code === "22023" ? "signed in" : body.code === "42501" ? "NOT signed in" : `${r.status} ${body.code ?? ""}`, server };
};

let notHonoured = 0;
for (let round = 1; round <= 6; round++) {
  const token = await newToken();
  const c = claims(token);
  const issued = Date.now();
  const row = [];
  for (const wait of [0, 250, 500, 1000, 2000, 3000]) {
    const due = issued + wait;
    if (Date.now() < due) await new Promise((r) => setTimeout(r, due - Date.now()));
    const p = await probe(token);
    row.push(`+${wait}ms ${p.seen}`);
    if (p.seen !== "signed in") notHonoured++;
    if (wait === 0) row.unshift(`token iat vs server clock: ${c.iat - Math.floor(p.server / 1000)} s (nbf ${c.nbf != null ? c.nbf - c.iat : "none"} s after iat)`);
  }
  console.log(`round ${round}: ${row.join(" · ")}`);
}
// Does reading the session again give a different token each time?
const t1 = await newToken();
const t2 = await newToken();
console.log(`two session reads in a row give ${t1 === t2 ? "the same token" : "different tokens"} (iat ${claims(t1).iat} / ${claims(t2).iat})`);
console.log(notHonoured ? `PROBE: ${notHonoured} request(s) made with a valid token were treated as signed out` : "PROBE: every request with a fresh token was honoured");

// Clean up the account (a fresh sign-in is required for deletion).
const si = await fetch(`${BASE}/neon/auth/sign-in/email`, {
  method: "POST",
  headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const c2 = si.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const tok = (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie: c2 } })).json()).token;
await new Promise((r) => setTimeout(r, 3000));
const d = await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, {
  method: "POST",
  headers: { ...BYPASS, authorization: `Bearer ${tok}`, "content-type": "application/json" },
  body: JSON.stringify({ p_confirm: "DELETE" }),
});
console.log(`cleanup: temporary account ${d.ok ? "deleted" : `NOT deleted (${d.status})`}`);
