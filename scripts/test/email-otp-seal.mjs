/**
 * Seals codes read from the test inbox to the running test's public key (from
 * its "PUBKEY=" log line), for the BLOB input of email-otp-live.mjs. Only that
 * test's private key (in its Actions cache) can open it.
 *
 *   PUBKEY=… node scripts/test/email-otp-seal.mjs '{"a_v1":"123456","a_v2":"654321"}'
 */
const pub = await crypto.subtle.importKey("raw", Buffer.from(process.env.PUBKEY ?? "", "base64url"), { name: "ECDH", namedCurve: "P-256" }, false, []);
const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(process.argv[2] ?? "{}"));
process.stdout.write(Buffer.concat([Buffer.from(await crypto.subtle.exportKey("raw", eph.publicKey)), iv, Buffer.from(ct)]).toString("base64url") + "\n");
