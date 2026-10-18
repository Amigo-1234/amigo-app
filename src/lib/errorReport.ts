import { dataSource } from "../data";

/**
 * Reports uncaught errors so admins can see error rates. Redacted here first
 * (emails, ids, long numbers, URLs) and again on the server; at most 10 per
 * page load, each message once; never message content or keys (those never
 * reach error text in the first place). The server doesn't link rows to people.
 */
const MAX_PER_LOAD = 10;
const sent = new Set<string>();

export const redact = (s: string) =>
  s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "<email>")
    .replace(/https?:\/\/[^\s)"']+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d{4,}/g, "<n>")
    .slice(0, 300);

export function reportError(kind: "error" | "unhandledrejection" | "render", error: unknown) {
  if (!dataSource.reportError || sent.size >= MAX_PER_LOAD) return;
  const e = error as { name?: string; message?: string } | null;
  const message = redact(`${e?.name ?? "Error"}: ${e?.message ?? String(error)}`);
  if (sent.has(message)) return;
  sent.add(message);
  // Fire and forget: reporting must never cause another error.
  dataSource.reportError(kind, message, location.pathname).catch(() => undefined);
}

export function installErrorReporting() {
  window.addEventListener("error", (ev) => reportError("error", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError("unhandledrejection", ev.reason));
}

/**
 * A like, reply or other action that failed and was shown to the person as a
 * toast (so never reaches the global handlers). Sent a moment later, so a
 * failure caused by a not-yet-honoured sign-in can still be recorded.
 */
export function reportActionFailure(action: string, error: unknown) {
  const e = error as { code?: string; pgCode?: string; message?: string } | null;
  const codes = [e?.code, e?.pgCode].filter(Boolean).join("/");
  const failure = { name: `${action} failed`, message: `${codes ? `[${codes}] ` : ""}${e?.message ?? String(error)}` };
  setTimeout(() => reportError("error", failure), 1500);
}
