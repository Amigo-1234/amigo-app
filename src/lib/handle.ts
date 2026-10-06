/** Derive a URL/handle-safe username from a display name or email. */
export function toHandle(input: string | null | undefined): string {
  const base = (input ?? "").split("@")[0].normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const cleaned = base.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 24) || "amigo";
}
