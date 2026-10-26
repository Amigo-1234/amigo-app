/**
 * Read-only check of what search engines get from a deployment: status, type and
 * X-Robots-Tag of the homepage, icons, robots.txt, sitemap and a legal page (as
 * Googlebot), the homepage <head> (title, description, canonical, icons, Open Graph,
 * JSON-LD), and whether robots.txt lets Google fetch the files it needs (Google's
 * longest-match rule, Allow winning ties).
 *
 *   BASE=https://amigoworld.com.ng node scripts/test/seo-probe.mjs
 */
const BASE = (process.env.BASE ?? "https://amigoworld.com.ng").replace(/\/+$/, "");
const UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const H = { "user-agent": UA, ...(process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {}) };
let issues = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "ISSUE"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) issues++;
};
const info = (label, extra) => console.log(`info ${label} — ${extra}`);

async function get(path) {
  const res = await fetch(BASE + path, { headers: H, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type") ?? "", robots: res.headers.get("x-robots-tag") ?? "", location: res.headers.get("location") ?? "", buf, text: buf.toString("utf8") };
}

// ---- robots.txt (group for Googlebot, else *)
const robotsRes = await get("/robots.txt");
info("/robots.txt", `${robotsRes.status} ${robotsRes.type}`);
console.log(robotsRes.text.split("\n").map((l) => `     | ${l}`).join("\n"));
const rules = [];
{
  let active = false;
  let seenGroup = false;
  for (const raw of robotsRes.text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) {
      if (seenGroup) active = false;
      if (v === "*" || /googlebot/i.test(v)) active = true;
      seenGroup = false;
    } else {
      seenGroup = true;
      if (active && /^(allow|disallow)$/i.test(k) && v) rules.push({ allow: /^allow$/i.test(k), path: v });
    }
  }
}
const toRe = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
function allowed(path) {
  let best = null;
  for (const r of rules) if (toRe(r.path).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  return !best || best.allow;
}

// ---- homepage
const home = await get("/");
const html = home.text;
const attr = (re) => html.match(re)?.[1] ?? "";
const metaName = (n) => attr(new RegExp(`<meta[^>]+name="${n}"[^>]+content="([^"]*)"`, "i"));
const metaProp = (p) => attr(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`, "i"));
info("homepage", `${home.status} ${home.type}${home.robots ? ` X-Robots-Tag: ${home.robots}` : ""}`);
info("title", attr(/<title>([^<]*)<\/title>/i));
info("meta description", metaName("description"));
info("canonical (static)", attr(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i));
info("robots meta", metaName("robots") || "none");
const icons = [...html.matchAll(/<link[^>]+rel="([^"]*icon[^"]*)"[^>]+href="([^"]*)"[^>]*>/gi)].map((m) => ({ rel: m[1], href: m[2], tag: m[0] }));
info("icon links", icons.map((i) => `${i.rel} ${i.href}`).join(" | ") || "none");
for (const p of ["og:title", "og:description", "og:url", "og:image", "og:type", "og:site_name"]) info(p, metaProp(p));
info("twitter:card", metaName("twitter:card"));
const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
info("JSON-LD blocks", ld.length ? ld.map((b) => { try { const j = JSON.parse(b); return [].concat(j["@graph"] ?? j).map((x) => x["@type"]).join("+"); } catch { return "INVALID"; } }).join(", ") : "none");
const bodyText = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
info("text in the HTML before JavaScript runs", JSON.stringify(bodyText.slice(0, 200)));
ok("homepage is 200 HTML and not noindex", home.status === 200 && /html/.test(home.type) && !/noindex/i.test(home.robots + metaName("robots")));

// ---- files Google needs
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gi)].map((m) => m[1]);
const paths = ["/", "/favicon.svg", "/favicon.ico", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest", "/sitemap.xml", "/legal/terms", ...icons.map((i) => i.href), ...scripts.slice(0, 2), ...styles.slice(0, 1)]
  .map((p) => p.replace(/^https?:\/\/[^/]+/, ""))
  .filter((p, i, a) => p.startsWith("/") && a.indexOf(p) === i);
for (const p of paths) {
  const r = p === "/" ? home : await get(p);
  const isImage = /^image\//.test(r.type);
  const sig = r.buf.subarray(0, 8).toString("hex");
  const realImage = isImage && (sig.startsWith("89504e47") || sig.startsWith("00000100") || r.text.trimStart().startsWith("<svg") || r.text.trimStart().startsWith("<?xml"));
  console.log(`info ${p} — ${r.status} ${r.type || "?"} ${r.buf.length} B${r.robots ? ` X-Robots-Tag: ${r.robots}` : ""}${r.location ? ` → ${r.location}` : ""} | robots.txt: ${allowed(p) ? "allowed" : "BLOCKED"}${isImage ? (realImage ? " | real image" : " | NOT AN IMAGE") : ""}`);
}
ok("robots.txt allows the homepage", allowed("/"));
for (const i of icons) ok(`robots.txt allows the icon ${i.href}`, allowed(i.href.replace(/^https?:\/\/[^/]+/, "")));
ok("robots.txt allows the og:image", allowed(metaProp("og:image").replace(/^https?:\/\/[^/]+/, "") || "/"));
for (const s of [...scripts, ...styles]) ok(`robots.txt allows ${s} (Google needs it to render the page)`, allowed(s.replace(/^https?:\/\/[^/]+/, "")));
const ico = await get("/favicon.ico");
ok("/favicon.ico is a real icon or a 404 (not the app's HTML)", ico.status === 404 || (/image/.test(ico.type) && !/html/.test(ico.type)), `${ico.status} ${ico.type}`);
const missing = await get("/this-page-does-not-exist-seo-probe");
info("unknown path", `${missing.status} ${missing.type}`);
console.log(issues ? `${issues} ISSUE(S)` : "NO ISSUES");
