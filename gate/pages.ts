/**
 * The pages the access gate (middleware.ts) serves while the site is closed: the public
 * "under development" page, and the team access form. Self-contained (inline CSS and logo);
 * the only files they load are the two fonts in public/_maintenance/fonts.
 */

const MARK = `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 0h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H3a3 3 0 0 1-3-3V9a9 9 0 0 1 9-9z" fill="#ff5a3c"/><circle cx="14.6" cy="17.2" r="5.6" fill="none" stroke="#1d0a05" stroke-width="3.2"/><rect x="19.6" y="10" width="3.3" height="13" rx="1.65" fill="#1d0a05"/></svg>`;

const STYLE = `
  @font-face { font-family: "Bricolage"; src: url("/_maintenance/fonts/bricolage-grotesque-latin-standard-normal.woff2") format("woff2"); font-weight: 200 800; font-display: swap; }
  @font-face { font-family: "Geist"; src: url("/_maintenance/fonts/geist-latin-wght-normal.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
  :root { --bg: #0c0c0e; --card: #141417; --line: #2a2a30; --text: #f3f1ee; --muted: #b3ada5; --faint: #7d776f; --coral: #ff5a3c; --on-coral: #1d0a05; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; height: 100%; }
  body {
    margin: 0; min-height: 100%; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text);
    font: 16px/1.6 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* A soft coral glow behind the content, like the reservation site. */
  body::before {
    content: ""; position: fixed; inset: -20vh -20vw auto; height: 70vh; z-index: -1; pointer-events: none;
    background: radial-gradient(closest-side, rgba(255, 90, 60, 0.20), rgba(255, 90, 60, 0) 70%);
  }
  header, main, footer { width: 100%; max-width: 640px; margin: 0 auto; padding-left: 20px; padding-right: 20px; }
  header { padding-top: max(28px, env(safe-area-inset-top)); }
  .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font: 700 20px/1 "Bricolage", sans-serif; letter-spacing: -0.01em; }
  main { flex: 1; display: flex; flex-direction: column; justify-content: center; padding-top: 56px; padding-bottom: 56px; }
  .status { display: inline-flex; align-items: center; gap: 10px; align-self: flex-start; margin: 0 0 22px; padding: 7px 14px 7px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 14px; font-weight: 550; }
  .status i { width: 8px; height: 8px; border-radius: 50%; background: var(--coral); box-shadow: 0 0 0 0 rgba(255, 90, 60, 0.6); animation: pulse 2.4s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255, 90, 60, 0.55); } 70%, 100% { box-shadow: 0 0 0 10px rgba(255, 90, 60, 0); } }
  @media (prefers-reduced-motion: reduce) { .status i { animation: none; } }
  h1 { margin: 0 0 18px; font: 800 clamp(34px, 8.4vw, 56px)/1.04 "Bricolage", sans-serif; letter-spacing: -0.035em; text-wrap: balance; }
  .lede { margin: 0; max-width: 34em; color: var(--muted); font-size: clamp(17px, 2.4vw, 19px); line-height: 1.6; text-wrap: pretty; }
  .aside { margin-top: 36px; padding: 18px 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; }
  .aside p { margin: 0; color: var(--muted); font-size: 15px; }
  .aside strong { display: block; color: var(--text); font-weight: 600; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: var(--coral); color: var(--on-coral); font: 650 15px/1 "Geist", sans-serif; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .btn:hover { filter: brightness(1.06); }
  .btn:focus-visible, .brand:focus-visible, input:focus-visible { outline: 2px solid var(--coral); outline-offset: 3px; }
  footer { padding-bottom: max(24px, env(safe-area-inset-bottom)); color: var(--faint); font-size: 13px; }
  footer p { margin: 0; padding-top: 18px; border-top: 1px solid var(--line); }
  form { display: grid; gap: 12px; max-width: 420px; margin-top: 8px; }
  label { color: var(--muted); font-size: 14px; font-weight: 550; }
  input { width: 100%; min-height: 48px; padding: 0 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--text); font: 16px "Geist", sans-serif; }
  .error { margin: 0; color: #ff8a73; font-size: 14px; }
  .muted { color: var(--faint); font-size: 14px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0c0c0e">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta name="description" content="Amigo World isn't publicly available just yet. Please check back soon.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/_maintenance/fonts/bricolage-grotesque-latin-standard-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>${STYLE}</style>
</head>
<body>
<header><span class="brand">${MARK}Amigo World</span></header>
${body}
<footer><p>© Amigo World</p></footer>
</body>
</html>`;
}

/** What everyone without team access sees, at every address. */
export const UNDER_DEVELOPMENT_HTML = shell(
  "Amigo World · Under development",
  `<main>
  <p class="status"><i aria-hidden="true"></i>Under development</p>
  <h1>The Site Is Still Under Development</h1>
  <p class="lede">We're currently working behind the scenes to make Amigo World better. Our platform isn't publicly available just yet. Please check back soon.</p>
  <div class="aside">
    <p><strong>Want to keep your name?</strong>Username reservations are open.</p>
    <a class="btn" href="https://reserve.amigoworld.com.ng">Reserve a username</a>
  </div>
</main>`,
);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The team access form (at an unlinked address). */
export function teamAccessHtml(state: { error?: string; signedIn?: boolean } = {}): string {
  if (state.signedIn) {
    return shell(
      "Amigo World · Team access",
      `<main>
  <h1>Team access is on</h1>
  <p class="lede">This browser can open Amigo World while the site is closed to the public. Sign in as usual; admin pages still need an admin account.</p>
  <form method="post" action="/_team/leave">
    <a class="btn" href="/">Open Amigo World</a>
    <button class="btn" type="submit" style="background:transparent;color:var(--muted);border:1px solid var(--line)">Turn off team access in this browser</button>
  </form>
</main>`,
    );
  }
  return shell(
    "Amigo World · Team access",
    `<main>
  <h1>Team access</h1>
  <p class="lede">For the Amigo World team while the site is closed to the public.</p>
  <form method="post" action="/_team">
    <label for="key">Access key</label>
    <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
    ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
    <button class="btn" type="submit">Continue</button>
    <p class="muted">The key is set by the site owner in the hosting settings. It keeps this browser signed in to team access for 30 days.</p>
  </form>
</main>`,
  );
}
