/** Human copy for backend failures. Never show raw SDK messages to people. */
export function describeError(error: unknown): { title: string; body: string } {
  const code = (error as { code?: string })?.code ?? "";
  if (!navigator.onLine || code === "unavailable") {
    return { title: "You're offline", body: "Check your connection — we'll load posts as soon as you're back." };
  }
  if (code === "permission-denied") {
    return { title: "Can't load posts", body: "Your account doesn't have access to this right now. Try signing out and back in." };
  }
  return { title: "Something went wrong", body: "We couldn't load posts. This is usually temporary." };
}
