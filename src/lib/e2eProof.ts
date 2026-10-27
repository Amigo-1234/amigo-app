/**
 * Cryptographic checks for the encrypted-message key backup and identity resets,
 * shared by the browser (building requests) and the API (api/e2e-backup.ts,
 * api/e2e-identity.ts, verifying them). WebCrypto only (Ed25519, SHA-256), so it
 * runs in browsers, Vercel's edge runtime and Node.
 *
 * The keys are the Matrix ones the app already uses (matrix-sdk-crypto-wasm):
 *   - a device's keys object is signed by the account's self-signing key
 *     (signatures[user]["ed25519:<self-signing key>"]);
 *   - the self-signing key is signed by the master key
 *     (signatures[user]["ed25519:<master key>"]);
 *   - the master key is the root of trust (as on every other screen).
 * Signatures cover the object's canonical JSON without "signatures" and
 * "unsigned" (Matrix signed JSON); keys and signatures are unpadded base64.
 *
 * A backup write is proven to come from the device itself: the device signs
 * proofMessage(...) with its own device key (OlmMachine.sign signs the exact
 * bytes); the server issued the challenge and accepts each one once.
 */

const enc = new TextEncoder();

/** Matrix canonical JSON: sorted keys, no whitespace, plain JSON escapes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The bytes a Matrix signature covers. */
export function signedJson(o: Record<string, unknown>): string {
  const { signatures: _s, unsigned: _u, ...rest } = o;
  return canonicalJson(rest);
}

function b64(s: string): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256b64(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

/** Ed25519 check; false (never a throw) for anything malformed. */
export async function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): Promise<boolean> {
  const key = b64(publicKeyB64);
  const sig = b64(signatureB64);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, enc.encode(message));
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The single ed25519 public key of a cross-signing key object, if it is a well-formed one for `usage`. */
export function crossSigningKey(k: unknown, user: string, usage: string): string | null {
  const o = obj(k);
  const keys = obj(o?.keys);
  if (!o || !keys || o.user_id !== user || !Array.isArray(o.usage) || !o.usage.includes(usage)) return null;
  const ids = Object.keys(keys);
  if (ids.length !== 1 || !ids[0].startsWith("ed25519:")) return null;
  const pub = keys[ids[0]];
  return typeof pub === "string" && ids[0] === `ed25519:${pub}` ? pub : null;
}

/** `signer` signed `o` (Matrix signed JSON) as signatures[user]["ed25519:<signer>"]. */
export async function signedBy(o: Json, user: string, signer: string): Promise<boolean> {
  const sig = obj(obj(o.signatures)?.[user])?.[`ed25519:${signer}`];
  return typeof sig === "string" && verifyEd25519(signer, signedJson(o), sig);
}

export type TrustResult = { ok: true; deviceKey: string } | { ok: false; reason: string };

/**
 * The device is vouched for by the account's current identity: its keys are signed by the
 * self-signing key, which is signed by the master key. Returns the device's ed25519 key.
 */
export async function verifyDeviceTrust(m: { user: string; device: string; device_keys: unknown; master: unknown; self_signing: unknown }): Promise<TrustResult> {
  const dk = obj(m.device_keys);
  if (!dk || dk.user_id !== m.user || dk.device_id !== m.device) return { ok: false, reason: "device keys" };
  const deviceKey = obj(dk.keys)?.[`ed25519:${m.device}`];
  if (typeof deviceKey !== "string") return { ok: false, reason: "device key" };
  const master = crossSigningKey(m.master, m.user, "master");
  const ssk = crossSigningKey(m.self_signing, m.user, "self_signing");
  if (!master || !ssk) return { ok: false, reason: "cross-signing keys" };
  if (!(await signedBy(obj(m.self_signing)!, m.user, master))) return { ok: false, reason: "self-signing key not signed by the master key" };
  if (!(await signedBy(dk, m.user, ssk))) return { ok: false, reason: "device not signed by the self-signing key" };
  return { ok: true, deviceKey };
}

/** A new identity hangs together: self-signing (and user-signing, if given) keys signed by the new master key. */
export async function verifyNewIdentity(user: string, k: { master: unknown; self_signing: unknown; user_signing?: unknown }): Promise<boolean> {
  const master = crossSigningKey(k.master, user, "master");
  if (!master || !crossSigningKey(k.self_signing, user, "self_signing")) return false;
  if (!(await signedBy(obj(k.self_signing)!, user, master))) return false;
  if (k.user_signing != null) {
    if (!crossSigningKey(k.user_signing, user, "user_signing") || !(await signedBy(obj(k.user_signing)!, user, master))) return false;
  }
  return true;
}

export type ProofOp = "create" | "put";

/** What the device signs for one backup write. */
export function proofMessage(op: ProofOp, user: string, device: string, nonce: string, payloadHash: string): string {
  return ["amigo-e2e-backup-proof-v1", op, user, device, nonce, payloadHash].join("\n");
}
