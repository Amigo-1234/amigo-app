/**
 * Step 1 — Extract (read-only).
 *
 *   node scripts/migration/extract.ts --source admin [--out migration-data/snapshot.json]
 *   node scripts/migration/extract.ts --source rest  [--out ...]
 *
 * admin: Firebase Admin SDK. Needs GOOGLE_APPLICATION_CREDENTIALS pointing at a
 *        service-account JSON for amigo-world-ebfab. Complete: includes Auth users
 *        and "phantom" parent docs. This is the source for the real migration.
 * rest:  public Firestore REST API with no credentials. Only works while the
 *        Firestore rules allow public reads (they currently do). No Auth users.
 *        Good for dry runs and audits.
 *
 * Nothing is ever written to Firebase.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { AuthUserRecord, Plain, RawDoc, Snapshot } from "./lib/snapshot.ts";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "amigo-world-ebfab";

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: "admin" },
    out: { type: "string", default: "migration-data/snapshot.json" },
  },
});

// ---------------------------------------------------------------- REST source

const REST_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

type RestValue = Record<string, unknown>;

function fromRest(v: RestValue): Plain {
  const [type, x] = Object.entries(v)[0] ?? ["nullValue", null];
  switch (type) {
    case "nullValue":
      return null;
    case "booleanValue":
      return x as boolean;
    case "integerValue":
      return Number(x);
    case "doubleValue":
      return Number(x);
    case "stringValue":
      return x as string;
    case "timestampValue":
      return { __ts: new Date(x as string).toISOString() };
    case "mapValue":
      return Object.fromEntries(Object.entries((x as { fields?: Record<string, RestValue> }).fields ?? {}).map(([k, vv]) => [k, fromRest(vv)]));
    case "arrayValue":
      return ((x as { values?: RestValue[] }).values ?? []).map(fromRest);
    case "referenceValue":
      return { __ref: String(x).split("/documents/")[1] ?? String(x) };
    case "geoPointValue":
      return x as Plain;
    case "bytesValue":
      return { __bytes: x as string };
    default:
      return null;
  }
}

async function restList(collectionPath: string): Promise<RawDoc[]> {
  const out: RawDoc[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${REST_BASE}/${collectionPath}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url);
    const body = (await res.json()) as {
      documents?: { name: string; fields?: Record<string, RestValue> }[];
      nextPageToken?: string;
      error?: { status: string; message: string };
    };
    if (body.error) throw new Error(`${collectionPath}: ${body.error.status} ${body.error.message}`);
    for (const d of body.documents ?? []) {
      const path = d.name.split("/documents/")[1];
      out.push({ id: path.split("/").pop()!, path, data: fromRest({ mapValue: { fields: d.fields ?? {} } }) as Record<string, Plain> });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

async function extractRest(): Promise<Snapshot> {
  const notes = [
    "Extracted through the public REST API: Firebase Auth users are NOT included.",
    "Users that only exist as parents of following/followers subcollections are found by probing every uid seen in the data.",
  ];
  const [users, posts, globalChat] = await Promise.all([restList("users"), restList("posts"), restList("globalChat")]);

  const comments: RawDoc[] = [];
  for (const p of posts) comments.push(...(await restList(`posts/${p.id}/comments`)));

  // Every uid we know about, so subcollections under phantom user docs are not missed.
  const uids = new Set<string>(users.map((u) => u.id));
  const authorOf = (d: RawDoc) => [d.data.authorId, d.data.userId, d.data.uid].find((x) => typeof x === "string") as string | undefined;
  for (const d of [...posts, ...comments, ...globalChat]) {
    const a = authorOf(d);
    if (a) uids.add(a);
  }
  for (const p of posts) {
    const reacted = p.data.reacted;
    if (reacted && typeof reacted === "object" && !Array.isArray(reacted)) {
      for (const arr of Object.values(reacted)) if (Array.isArray(arr)) arr.forEach((x) => typeof x === "string" && uids.add(x));
    }
    if (Array.isArray(p.data.likes)) p.data.likes.forEach((x) => typeof x === "string" && uids.add(x));
    if (Array.isArray(p.data.savedBy)) p.data.savedBy.forEach((x) => typeof x === "string" && uids.add(x));
  }

  const following: RawDoc[] = [];
  const followers: RawDoc[] = [];
  for (const uid of uids) {
    following.push(...(await restList(`users/${uid}/following`)));
    followers.push(...(await restList(`users/${uid}/followers`)));
  }
  // Discover more uids via the follow graph (one extra hop is enough to close it here).
  const more = new Set<string>();
  for (const f of [...following, ...followers]) if (!uids.has(f.id)) more.add(f.id);
  for (const uid of more) {
    following.push(...(await restList(`users/${uid}/following`)));
    followers.push(...(await restList(`users/${uid}/followers`)));
  }

  return {
    meta: { projectId: PROJECT_ID, extractedAt: new Date().toISOString(), source: "rest", hasAuthUsers: false, notes },
    authUsers: null,
    users,
    following,
    followers,
    posts,
    comments,
    globalChat,
  };
}

// --------------------------------------------------------------- Admin source

async function extractAdmin(): Promise<Snapshot> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON (Project settings → Service accounts).");
  }
  const { initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore, Timestamp } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore(app);

  const toPlain = (v: unknown): Plain => {
    if (v === null || v === undefined) return null;
    if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
    if (Array.isArray(v)) return v.map(toPlain);
    if (typeof v === "object") {
      const o = v as Record<string, unknown> & { path?: string; firestore?: unknown };
      if (o.firestore && typeof o.path === "string") return { __ref: o.path };
      if (Buffer.isBuffer(v)) return { __bytes: (v as Buffer).toString("base64") };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toPlain(x)]));
    }
    return v as Plain;
  };

  type Ref = FirebaseFirestore.DocumentReference;
  const readCollection = async (ref: FirebaseFirestore.CollectionReference): Promise<RawDoc[]> => {
    // listDocuments() also returns phantom parents that only hold subcollections.
    const refs: Ref[] = await ref.listDocuments();
    const snaps = refs.length ? await db.getAll(...refs) : [];
    return snaps.map((s) => ({ id: s.id, path: s.ref.path, data: (s.exists ? toPlain(s.data()) : {}) as Record<string, Plain>, missing: !s.exists || undefined }));
  };

  const [users, posts, globalChat] = await Promise.all([
    readCollection(db.collection("users")),
    readCollection(db.collection("posts")),
    readCollection(db.collection("globalChat")),
  ]);
  const comments: RawDoc[] = [];
  for (const p of posts) comments.push(...(await readCollection(db.collection(`posts/${p.id}/comments`))));
  const following: RawDoc[] = [];
  const followers: RawDoc[] = [];
  for (const u of users) {
    following.push(...(await readCollection(db.collection(`users/${u.id}/following`))));
    followers.push(...(await readCollection(db.collection(`users/${u.id}/followers`))));
  }

  const rootCollections = (await db.listCollections()).map((c) => c.id);
  const notes = [`Root collections present: ${rootCollections.join(", ")}`];
  const unknown = rootCollections.filter((c) => !["users", "posts", "globalChat"].includes(c));
  if (unknown.length) notes.push(`NOT migrated (unknown collections, review manually): ${unknown.join(", ")}`);

  const authUsers: AuthUserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAuth(app).listUsers(1000, pageToken);
    for (const u of page.users) {
      // Password hashes are deliberately not exported: Supabase cannot import Firebase scrypt.
      authUsers.push({
        uid: u.uid,
        email: u.email ?? null,
        emailVerified: u.emailVerified,
        displayName: u.displayName ?? null,
        photoURL: u.photoURL ?? null,
        disabled: u.disabled,
        providers: u.providerData.map((p) => p.providerId),
        createdAt: u.metadata.creationTime ? new Date(u.metadata.creationTime).toISOString() : null,
        lastSignInAt: u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : null,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  return {
    meta: { projectId: PROJECT_ID, extractedAt: new Date().toISOString(), source: "admin", hasAuthUsers: true, notes },
    authUsers,
    users,
    following,
    followers,
    posts,
    comments,
    globalChat,
  };
}

// ----------------------------------------------------------------------- main

const snapshot = args.source === "rest" ? await extractRest() : await extractAdmin();
mkdirSync(dirname(args.out!), { recursive: true });
writeFileSync(args.out!, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
console.log(
  `Snapshot written to ${args.out} (${snapshot.meta.source}): ` +
    `${snapshot.authUsers?.length ?? "n/a"} auth users, ${snapshot.users.length} user docs, ${snapshot.posts.length} posts, ` +
    `${snapshot.comments.length} comments, ${snapshot.following.length} following / ${snapshot.followers.length} followers edges, ` +
    `${snapshot.globalChat.length} chat messages`,
);
for (const n of snapshot.meta.notes) console.log(`  note: ${n}`);
