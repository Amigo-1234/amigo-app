/**
 * Amigo World's sign-in emails (verification, password reset, sign-in codes and
 * links). Built for email clients: tables and inline styles, no images or web
 * fonts (readable when remote content is blocked), no tracking, a plain-text
 * twin. The code shown is always the one Neon Auth generated — nothing here
 * makes or changes codes. Wording only states what is known: someone asked for
 * this code with this address; nothing has changed on the account.
 */

export type AuthEmailKind = "email-verification" | "forget-password" | "sign-in";

export type AuthEmail = { subject: string; html: string; text: string };

const SITE = "amigoworld.com.ng";
const URL_ = `https://${SITE}`;

const C = {
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
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * How long Neon made the code valid for, in whole minutes: its own expiry minus its own issue time
 * (both from the event, so no clock but Neon's is involved). Unknown → null ("expires soon").
 */
export function validMinutes(expiresAt: string | undefined, issuedAt: string | undefined): number | null {
  const end = expiresAt ? Date.parse(expiresAt) : NaN;
  const start = issuedAt ? Date.parse(issuedAt) : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}

const COPY: Record<AuthEmailKind, { subject: string; preview: string; heading: string; intro: string[]; codeLabel: string; ignore: string }> = {
  "email-verification": {
    subject: "Verify your email • Amigo World",
    preview: "Confirm your email address to finish joining Amigo World.",
    heading: "Welcome to Amigo World!",
    intro: ["You're one step away from joining the community.", "Use the verification code below to confirm your email address."],
    codeLabel: "Your verification code",
    ignore: "If you didn't create an Amigo World account, you can ignore this email — the address won't be confirmed without this code.",
  },
  "forget-password": {
    subject: "Reset your password • Amigo World",
    preview: "Here's how to choose a new password for Amigo World.",
    heading: "Reset your password",
    intro: ["Someone asked to reset the password for the Amigo World account that uses this email address.", "Enter the code below in the app to choose a new password."],
    codeLabel: "Your password reset code",
    ignore: "If you didn't ask for this, you can ignore this email — your password stays the same unless this code is used.",
  },
  "sign-in": {
    subject: "Your sign-in code • Amigo World",
    preview: "Finish signing in to Amigo World.",
    heading: "Sign in to Amigo World",
    intro: ["Use the code below to finish signing in."],
    codeLabel: "Your sign-in code",
    ignore: "If you didn't try to sign in, you can ignore this email — nobody can sign in with this code unless they also have access to your inbox.",
  },
};

const LINK_COPY: Record<AuthEmailKind, { subject: string; heading: string; intro: string; button: string }> = {
  "email-verification": { subject: "Verify your email • Amigo World", heading: "Confirm your email address", intro: "Tap the button below to confirm this email address for your Amigo World account.", button: "Confirm email" },
  "forget-password": { subject: "Reset your password • Amigo World", heading: "Reset your password", intro: "Someone asked to reset the password for the Amigo World account that uses this email address. Tap the button below to choose a new one.", button: "Choose a new password" },
  "sign-in": { subject: "Your sign-in link • Amigo World", heading: "Sign in to Amigo World", intro: "Tap the button below to finish signing in.", button: "Sign in" },
};

/** The Amigo mark without an image: a coral tile carrying a lowercase "a". */
const MARK = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;background:${C.coral};border-radius:12px 12px 12px 4px;font:800 24px/40px ${FONT};color:${C.onCoral};text-align:center">a</td>
<td style="padding-left:12px;font:700 20px/1 ${FONT};color:${C.text};letter-spacing:-0.3px">Amigo World</td>
</tr></table>`;

function shell(preheader: string, body: string): string {
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
This is an automated message about your account. Replies aren't read.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const p = (s: string, extra = "") => `<p style="margin:0 0 12px;font:16px/1.6 ${FONT};color:${C.muted}${extra}">${s}</p>`;

export function codeEmail(kind: AuthEmailKind, code: string, minutes: number | null): AuthEmail {
  const c = COPY[kind];
  const expiry = minutes ? `This code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "This code expires soon.";
  // The code appears only in the body — never in the subject or the inbox preview line.
  const html = shell(
    c.preview,
    `<h1 style="margin:0 0 16px;font:700 26px/1.25 ${FONT};color:${C.text};letter-spacing:-0.4px">${esc(c.heading)}</h1>
${c.intro.map((s) => p(esc(s))).join("\n")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px">
<tr><td align="center" style="background:${C.codeBg};border:1px solid ${C.line};border-radius:14px;padding:22px 12px">
<div style="font:600 12px/1 ${FONT};color:${C.muted};letter-spacing:1.2px;text-transform:uppercase;margin-bottom:12px">${esc(c.codeLabel)}</div>
<div class="code" style="font:700 40px/1.1 ${MONO};color:${C.text};letter-spacing:10px;padding-left:10px;user-select:all;-webkit-user-select:all">${esc(code)}</div>
</td></tr>
</table>
${p(`<span style="color:${C.coral};font-weight:600">${esc(expiry)}</span>`, ";text-align:center;margin:12px 0 24px")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:20px">
${p(`<strong style="color:${C.text}">Keep this code private.</strong> Amigo World will never ask you for it by message, phone or email.`, ";font-size:14px")}
${p(esc(c.ignore), ";font-size:14px;margin:0")}
</td></tr></table>`,
  );
  const text = [
    c.heading,
    "",
    ...c.intro,
    "",
    `${c.codeLabel}: ${code}`,
    expiry,
    "",
    "Keep this code private. Amigo World will never ask you for it by message, phone or email.",
    c.ignore,
    "",
    `Amigo World · ${URL_}`,
    "This is an automated message about your account. Replies aren't read.",
  ].join("\n");
  return { subject: c.subject, html, text };
}

export function linkEmail(kind: AuthEmailKind, url: string, minutes: number | null): AuthEmail {
  const c = LINK_COPY[kind];
  const expiry = minutes ? `This link expires in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "This link expires soon.";
  const html = shell(
    c.intro,
    `<h1 style="margin:0 0 16px;font:700 26px/1.25 ${FONT};color:${C.text};letter-spacing:-0.4px">${esc(c.heading)}</h1>
${p(esc(c.intro))}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 12px"><tr>
<td style="background:${C.coral};border-radius:12px"><a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font:700 16px/1 ${FONT};color:${C.onCoral};text-decoration:none">${esc(c.button)}</a></td>
</tr></table>
${p(`<span style="color:${C.coral};font-weight:600">${esc(expiry)}</span>`)}
${p(`If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all;color:${C.text}">${esc(url)}</span>`, ";font-size:13px")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:20px">
${p("If you didn't ask for this, you can ignore this email — nothing changes unless the link is used.", ";font-size:14px;margin:0")}
</td></tr></table>`,
  );
  const text = [c.heading, "", c.intro, "", url, expiry, "", "If you didn't ask for this, you can ignore this email — nothing changes unless the link is used.", "", `Amigo World · ${URL_}`].join("\n");
  return { subject: c.subject, html, text };
}

export const isKind = (k: unknown): k is AuthEmailKind => k === "email-verification" || k === "forget-password" || k === "sign-in";
