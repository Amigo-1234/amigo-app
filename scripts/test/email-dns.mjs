/**
 * What the public DNS says about amigoworld.com.ng's email setup (read-only):
 * the apex's TXT (SPF) and MX records, DMARC, and the records a Resend domain
 * uses (send.<domain> MX + SPF, resend._domainkey DKIM). Flags the problems
 * that break delivery: two SPF records on one name, a DKIM value that doesn't
 * look like a key, no DMARC.
 *
 *   DOMAIN=amigoworld.com.ng [EXPECT=resend] node scripts/test/email-dns.mjs
 */
import { promises as dns } from "node:dns";

const DOMAIN = process.env.DOMAIN ?? "amigoworld.com.ng";
const EXPECT = process.env.EXPECT ?? ""; // "resend": the records must be there
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label} — ${extra}`);
const txt = (name) => dns.resolveTxt(name).then((r) => r.map((c) => c.join("")), (e) => (e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : Promise.reject(e)));
const mx = (name) => dns.resolveMx(name).then((r) => r.sort((a, b) => a.priority - b.priority), (e) => (e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : Promise.reject(e)));
const cname = (name) => dns.resolveCname(name).catch(() => []);

const apexTxt = await txt(DOMAIN);
const apexSpf = apexTxt.filter((t) => /^v=spf1/i.test(t));
info(`${DOMAIN} TXT`, apexTxt.length ? apexTxt.map((t) => t.slice(0, 120)).join(" | ") : "none");
info(`${DOMAIN} MX`, JSON.stringify(await mx(DOMAIN)));
ok(`${DOMAIN}: at most one SPF record`, apexSpf.length <= 1, String(apexSpf.length));

const dmarc = (await txt(`_dmarc.${DOMAIN}`)).filter((t) => /^v=DMARC1/i.test(t));
info(`_dmarc.${DOMAIN}`, dmarc.join(" | ") || "none");
ok("at most one DMARC record", dmarc.length <= 1, String(dmarc.length));

const sendTxt = await txt(`send.${DOMAIN}`);
const sendSpf = sendTxt.filter((t) => /^v=spf1/i.test(t));
const sendMx = await mx(`send.${DOMAIN}`);
info(`send.${DOMAIN} TXT`, sendTxt.join(" | ") || "none");
info(`send.${DOMAIN} MX`, JSON.stringify(sendMx));
ok(`send.${DOMAIN}: at most one SPF record`, sendSpf.length <= 1, String(sendSpf.length));

const dkimTxt = await txt(`resend._domainkey.${DOMAIN}`);
const dkimCname = await cname(`resend._domainkey.${DOMAIN}`);
info(`resend._domainkey.${DOMAIN}`, dkimTxt.length ? `TXT ${dkimTxt[0].slice(0, 40)}… (${dkimTxt[0].length} chars)` : dkimCname.length ? `CNAME ${dkimCname.join(",")}` : "none");

if (EXPECT === "resend") {
  ok("Resend return path: send MX points at Amazon SES feedback", sendMx.some((m) => /^feedback-smtp\.[a-z0-9-]+\.amazonses\.com\.?$/i.test(m.exchange)), JSON.stringify(sendMx));
  ok("Resend SPF on send.: includes amazonses.com", sendSpf.length === 1 && /include:amazonses\.com/i.test(sendSpf[0]), sendSpf.join(" | "));
  ok("Resend DKIM published (a public key)", dkimCname.length > 0 || dkimTxt.some((t) => /p=[A-Za-z0-9+/=]{100,}/.test(t)));
  ok("DMARC published", dmarc.length === 1, dmarc.join(" | "));
}
console.log(failures ? `${failures} FAILED` : "DNS CHECK DONE");
process.exit(failures ? 1 : 0);
