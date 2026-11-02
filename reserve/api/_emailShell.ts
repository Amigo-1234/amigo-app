/**
 * The email look shared with Amigo World's sign-in emails (api/_authEmail.ts in
 * the main app): tables and inline styles, no images or web fonts, readable when
 * remote content is blocked. Kept as a copy so this project builds on its own.
 */

export const SITE = "amigoworld.com.ng";
export const URL_ = `https://${SITE}`;

export const C = {
  page: "#0c0c0e",
  card: "#151518",
  line: "#2a2a30",
  text: "#f3f1ee",
  muted: "#a9a39b",
  faint: "#7d776f",
  coral: "#ff5a3c",
  onCoral: "#1d0a05",
  codeBg: "#1e1e23",
};
export const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO = "'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MARK = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;background:${C.coral};border-radius:12px 12px 12px 4px;font:800 24px/40px ${FONT};color:${C.onCoral};text-align:center">a</td>
<td style="padding-left:12px;font:700 20px/1 ${FONT};color:${C.text};letter-spacing:-0.3px">Amigo World</td>
</tr></table>`;

export function shell(preheader: string, body: string, footnote: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<meta name="x-apple-disable-message-reformatting">
<title>Amigo World</title>
<style>
  @media (max-width: 520px) { .card { padding: 28px 22px !important; } .code { font-size: 34px !important; letter-spacing: 8px !important; } }
  a { color: ${C.coral}; }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">
<tr><td style="padding:0 4px 20px">${MARK}</td></tr>
<tr><td class="card" style="background:${C.card};border:1px solid ${C.line};border-radius:20px;padding:36px 32px">${body}</td></tr>
<tr><td style="padding:24px 8px 0;font:13px/1.6 ${FONT};color:${C.faint};text-align:center">
Amigo World · <a href="${URL_}" style="color:${C.muted};text-decoration:none">${SITE}</a><br>
${esc(footnote)}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export const p = (s: string, extra = "") => `<p style="margin:0 0 12px;font:16px/1.6 ${FONT};color:${C.muted}${extra}">${s}</p>`;
