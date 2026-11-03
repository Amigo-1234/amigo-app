/**
 * Standard Web Push from an Edge function, with no third-party service:
 * the payload is encrypted to the browser (RFC 8291, aes128gcm) so the push
 * service only relays ciphertext, and each request is signed with our VAPID
 * key (RFC 8292) so push services accept only our messages for our
 * subscribers. Uses WebCrypto only.
 */
const enc = new TextEncoder();

export const b64u = {
  encode(bytes: ArrayBuffer | Uint8Array): string {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, length * 8));
}

/** RFC 8291 body for one subscription (a single record). */
export async function encryptPayload(payload: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = b64u.decode(p256dh);
  const auth = b64u.decode(authSecret);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the 0x02 "last record" delimiter.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(payload, new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export interface Vapid {
  /** Uncompressed P-256 public key, base64url (what browsers get as applicationServerKey). */
  publicKey: string;
  /** The private scalar d, base64url. */
  privateKey: string;
  /** mailto: or https: contact for push services. */
  subject: string;
}

let signingKey: { forKey: string; key: CryptoKey } | null = null;
async function vapidKey(v: Vapid): Promise<CryptoKey> {
  if (signingKey?.forKey === v.privateKey) return signingKey.key;
  const pub = b64u.decode(v.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: v.privateKey, x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), ext: false };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  signingKey = { forKey: v.privateKey, key };
  return key;
}

/** The Authorization header for one push service origin (valid 12 hours). */
export async function vapidAuth(v: Vapid, endpoint: string, now = Date.now()): Promise<string> {
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(v), enc.encode(unsigned) as BufferSource);
  return `vapid t=${unsigned}.${b64u.encode(sig)}, k=${v.publicKey}`;
}

export type PushOutcome = "ok" | "gone" | "failed";

/**
 * Sends one push. "gone": the subscription no longer exists (404/410) and
 * should be forgotten. Retries once on throttling or a push service error.
 */
export async function sendPush(
  v: Vapid,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: object,
  opts: { ttl?: number; topic?: string; urgency?: "high" | "normal" } = {},
): Promise<PushOutcome> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuth(v, sub.endpoint),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(opts.ttl ?? 24 * 3600),
          urgency: opts.urgency ?? "high",
          // Replaces an undelivered push with the same topic (e.g. several messages while offline).
          ...(opts.topic ? { topic: opts.topic } : {}),
        },
        body: body as BodyInit,
      });
    } catch {
      if (attempt === 0) continue;
      return "failed";
    }
    if (res.status === 404 || res.status === 410) return "gone";
    if (res.ok) return "ok";
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    return "failed";
  }
  return "failed";
}
