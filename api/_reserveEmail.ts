/**
 * Emails for username reservations (api/reserve.ts). Same look as the sign-in
 * emails (_authEmail.ts). They go only to the address that was typed, so they
 * may say what that address holds; the reservation page itself never does.
 */
import { C, esc, FONT, MONO, p, shell, URL_ } from "./_authEmail";

export type ReserveEmail = { subject: string; html: string; text: string };

const NOTE = "You're getting this because someone used this address on Amigo World's username reservation page. Replies aren't read.";
const IGNORE = "If this wasn't you, ignore this email — nothing is reserved unless the code is entered.";
const RESERVE_URL = "https://reserve.amigoworld.com.ng";

const h1 = (s: string) => `<h1 style="margin:0 0 16px;font:700 26px/1.25 ${FONT};color:${C.text};letter-spacing:-0.4px">${esc(s)}</h1>`;
const handle = (u: string) => `<strong style="color:${C.text}">@${esc(u)}</strong>`;
const rule = (inner: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:20px">${inner}</td></tr></table>`;
const footText = [`Amigo World · ${URL_}`, NOTE];

/** "12 May 2027", in Lagos time. */
export function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
}

export function codeEmail(username: string, code: string, renewal: boolean): ReserveEmail {
  const heading = renewal ? "Renew your username" : "Confirm your username";
  const intro = renewal
    ? `Enter this code on the reservation page to keep @${username} for another stretch.`
    : `Enter this code on the reservation page to reserve @${username} on Amigo World.`;
  // The code is never in the subject or the preview line.
  const html = shell(
    intro,
    `${h1(heading)}
${p(renewal ? `Enter this code on the reservation page to keep ${handle(username)} for another stretch.` : `Enter this code on the reservation page to reserve ${handle(username)} on Amigo World.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px">
<tr><td align="center" style="background:${C.codeBg};border:1px solid ${C.line};border-radius:14px;padding:22px 12px">
<div style="font:600 12px/1 ${FONT};color:${C.muted};letter-spacing:1.2px;text-transform:uppercase;margin-bottom:12px">Your code</div>
<div class="code" style="font:700 40px/1.1 ${MONO};color:${C.text};letter-spacing:10px;padding-left:10px;user-select:all;-webkit-user-select:all">${esc(code)}</div>
</td></tr>
</table>
${p(`<span style="color:${C.coral};font-weight:600">This code expires in 15 minutes.</span>`, ";text-align:center;margin:12px 0 24px")}
${rule(`${p(`<strong style="color:${C.text}">Keep this code private.</strong> Amigo World will never ask you for it by message, phone or email.`, ";font-size:14px")}
${p(esc(IGNORE), ";font-size:14px;margin:0")}`)}`,
    NOTE,
  );
  const text = [heading, "", intro, "", `Your code: ${code}`, "This code expires in 15 minutes.", "", "Keep this code private. Amigo World will never ask you for it by message, phone or email.", IGNORE, "", ...footText].join("\n");
  return { subject: renewal ? "Your code to renew your Amigo username" : "Your code to reserve your Amigo username", html, text };
}

export function confirmedEmail(username: string, expiresAt: string): ReserveEmail {
  const until = dateLabel(expiresAt);
  const lines = [
    `@${username} is reserved for you until ${until}.`,
    "When Amigo World opens, sign up with this email address and confirm it. The username will be waiting for you to claim.",
    "Nobody else can register it while your reservation lasts. In the last 30 days you can renew it from the reservation page with this same email.",
  ];
  const html = shell(
    lines[0],
    `${h1("Your username is reserved")}
${p(`${handle(username)} is reserved for you until <strong style="color:${C.text}">${esc(until)}</strong>.`)}
${p(esc(lines[1]))}
${p(esc(lines[2]))}
${rule(p("A reservation isn't an account: there's nothing to sign in to yet. Keep this email.", ";font-size:14px;margin:0"))}`,
    NOTE,
  );
  return { subject: `@${username} is reserved for you`, html, text: ["Your username is reserved", "", ...lines, "", ...footText].join("\n") };
}

/** Someone asked to reserve a name this address already holds, outside the renewal window. */
export function alreadyYoursEmail(username: string, expiresAt: string): ReserveEmail {
  const until = dateLabel(expiresAt);
  const lines = [`@${username} is already reserved for you, until ${until}. There's nothing more to do.`, `You can renew it from ${RESERVE_URL} in its last 30 days.`];
  const html = shell(lines[0], `${h1("It's already yours")}\n${p(`${handle(username)} is already reserved for you, until <strong style="color:${C.text}">${esc(until)}</strong>. There's nothing more to do.`)}\n${p(esc(lines[1]))}\n${rule(p(esc(IGNORE.replace("nothing is reserved unless the code is entered", "nothing has changed")), ";font-size:14px;margin:0"))}`, NOTE);
  return { subject: `@${username} is already reserved for you`, html, text: ["It's already yours", "", ...lines, "", ...footText].join("\n") };
}

/** This address holds as many names as allowed. */
export function limitEmail(username: string, held: string[]): ReserveEmail {
  const list = held.map((h) => `@${h}`).join(", ");
  const lines = [
    `You asked to reserve @${username}, but this email address already holds ${list}, which is as many as one address can reserve.`,
    "Nothing has changed, and your reservation is safe.",
  ];
  const html = shell(lines[0], `${h1("You've reached the limit")}\n${p(esc(lines[0]))}\n${p(esc(lines[1]))}`, NOTE);
  return { subject: "Your Amigo username reservation", html, text: ["You've reached the limit", "", ...lines, "", ...footText].join("\n") };
}
