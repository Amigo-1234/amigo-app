/**
 * POST /api/e2e-backup  (Bearer JWT)
 *   { op: "create" | "put", device, nonce, payload, signature }
 *
 * Writes to the encrypted-message key backup, only from a device that proves it
 * holds its own device key and is vouched for by the account's identity:
 *   1. `nonce` is a one-time challenge the device got from e2e_proof_challenge;
 *   2. `signature` is the device key's Ed25519 signature over
 *      proofMessage(op, user, device, nonce, sha256(payload)) — src/lib/e2eProof.ts;
 *   3. the device's keys must be signed by the self-signing key, and that by the
 *      master key (checked here; Postgres can't verify Ed25519);
 *   4. the write function (server secret only) uses up the challenge and refuses if
 *      the keys changed since step 3.
 * `payload` is the JSON text that was signed: { algorithm, auth_data } to start a
 * backup, { version, rooms } to add keys. The rooms hold keys encrypted to the
 * backup's public key; nothing here can read them.
 */
import { json, rpc } from "./_media";
import { proofMessage, sha256b64, verifyDeviceTrust, verifyEd25519, type ProofOp } from "../src/lib/e2eProof";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MAX_PAYLOAD = 2_000_000;

type Material = { user: string; device_keys: unknown; master: unknown; self_signing: unknown; hash: string };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const secret = ENV.PUSH_SERVER_SECRET;
  if (!secret) return json(503, { error: "not-configured" });
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return json(401, { error: "sign-in" });
  const token = auth.slice(7);

  const body = (await req.json().catch(() => null)) as { op?: string; device?: string; nonce?: string; payload?: string; signature?: string } | null;
  const op = body?.op as ProofOp | undefined;
  if (
    !body ||
    (op !== "create" && op !== "put") ||
    typeof body.device !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.device) ||
    typeof body.nonce !== "string" || !/^[0-9a-f]{64}$/.test(body.nonce) ||
    typeof body.payload !== "string" || body.payload.length > MAX_PAYLOAD ||
    typeof body.signature !== "string"
  )
    return json(400, { error: "bad-request" });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.payload);
  } catch {
    return json(400, { error: "bad-request" });
  }

  const got = await rpc<Material>(token, "e2e_proof_material", { p_key: secret, p_device: body.device });
  if (!got.ok) return json(got.status === 401 ? 401 : 403, { error: "refused", code: got.code, message: got.message });
  const m = got.data;

  const trust = await verifyDeviceTrust({ ...m, device: body.device });
  if (!trust.ok) return json(403, { error: "untrusted-device", code: "DM012", message: trust.reason });
  const message = proofMessage(op, m.user, body.device, body.nonce, await sha256b64(body.payload));
  if (!(await verifyEd25519(trust.deviceKey, message, body.signature))) return json(403, { error: "bad-signature", code: "DM012", message: "request signature" });

  const proof = { p_key: secret, p_device: body.device, p_nonce: body.nonce, p_hash: m.hash };
  const res =
    op === "create"
      ? await rpc<string>(token, "e2e_backup_create_verified", { ...proof, p_algorithm: payload.algorithm, p_auth_data: payload.auth_data })
      : await rpc<unknown>(token, "e2e_backup_put_verified", { ...proof, p_version: payload.version, p_rooms: payload.rooms ?? {} });
  if (!res.ok) return json(res.status === 401 ? 401 : 409, { error: "refused", code: res.code, message: res.message });
  return json(200, { data: res.data });
}
