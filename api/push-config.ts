/**
 * GET /api/push-config → { publicKey } (the VAPID public key browsers need to
 * subscribe), or 503 when push isn't set up on this deployment.
 */
import { json } from "./_media";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default function handler(): Response {
  const publicKey = ENV.VAPID_PUBLIC_KEY;
  if (!publicKey || !ENV.PUSH_SERVER_SECRET) return json(503, { error: "push-not-configured" });
  return json(200, { publicKey }, { "cache-control": "public, max-age=3600" });
}
