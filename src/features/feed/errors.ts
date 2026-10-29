/** Copy for the server's safety limits (rate limit, suspension, blocks), or null for anything else. */
export function limitText(error: unknown): string | null {
  const e = error as { code?: string; pgCode?: string } | null;
  const code = e?.pgCode || e?.code || "";
  if (code === "RL001" || code === "rate-limited") return "You're doing that a lot — take a short break and try again.";
  if (code === "AS001" || code === "suspended") return "Your account is suspended, so you can't do that right now.";
  if (code === "BL001") return "You can't follow this account.";
  if (code === "quota" || code === "MD003") return "You've reached the upload limit for now. Try again later.";
  if (code === "too-large" || code === "MD002") return "That file is too large or not a supported type.";
  return null;
}

/** Human copy for backend failures. Never show raw SDK messages to people. */
export function describeError(error: unknown, what = "posts"): { title: string; body: string } {
  const code = (error as { code?: string })?.code ?? "";
  if (!navigator.onLine || code === "unavailable") {
    return { title: "You're offline", body: `Check your connection — we'll load ${what} as soon as you're back.` };
  }
  if (code === "permission-denied") {
    return { title: `Can't load ${what}`, body: "Your account doesn't have access to this right now. Try signing out and back in." };
  }
  return { title: "Something went wrong", body: `We couldn't load ${what}. This is usually temporary.` };
}
