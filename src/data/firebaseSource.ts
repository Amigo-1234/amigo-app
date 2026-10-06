import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  limit as qLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
// LEGACY: kept only as the rollback path until the Supabase cutover is final.
// Do not add features here.
import { auth, db } from "../lib/firebase";
import { toHandle } from "../lib/handle";
import {
  EMPTY_REACTIONS,
  LIKE_REACTION,
  postFromLegacy,
  replyFromLegacy,
  type LegacyCommentDoc,
  type LegacyPostDoc,
} from "./legacy";
import { AuthError, type AuthErrorCode, type DataSource, type PersonSummary, type Viewer } from "./types";

const FIREBASE_AUTH_CODES: Record<string, AuthErrorCode> = {
  "auth/invalid-credential": "invalid-credentials",
  "auth/wrong-password": "invalid-credentials",
  "auth/user-not-found": "invalid-credentials",
  "auth/invalid-email": "invalid-email",
  "auth/email-already-in-use": "email-in-use",
  "auth/weak-password": "weak-password",
  "auth/too-many-requests": "rate-limited",
  "auth/network-request-failed": "network",
};

/** Run an auth call and translate Firebase error codes to AuthError. */
async function authCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    throw new AuthError(FIREBASE_AUTH_CODES[code] ?? "unknown", code);
  }
}

const SERVER_WAIT_MS = 12_000;

function displayNameOf(user: User): string {
  return user.displayName || user.email?.split("@")[0] || "amigo";
}

function toViewer(user: User): Viewer {
  const name = displayNameOf(user);
  return { id: user.uid, name, handle: toHandle(name), email: user.email, avatarUrl: user.photoURL };
}

/** Keeps users/{uid} in sync so people can find each other. Merge-only: never clears existing fields. */
async function upsertUserDoc(user: User) {
  await setDoc(
    doc(db, "users", user.uid),
    { displayName: displayNameOf(user), updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export const firebaseSource: DataSource = {
  kind: "firebase",

  onViewerChanged(cb) {
    return onAuthStateChanged(auth, (user) => {
      cb(user ? toViewer(user) : null);
      if (user) upsertUserDoc(user).catch((e) => console.warn("users doc sync failed", e));
    });
  },

  async signIn(email, password) {
    await authCall(() => signInWithEmailAndPassword(auth, email, password));
  },

  async signUp(email, password, name) {
    const cred = await authCall(() => createUserWithEmailAndPassword(auth, email, password));
    await updateProfile(cred.user, { displayName: name.trim() || email.split("@")[0] });
    await upsertUserDoc(cred.user);
    return { needsEmailConfirmation: false };
  },

  async sendPasswordReset(email) {
    await authCall(() => sendPasswordResetEmail(auth, email));
  },

  async updatePassword() {
    // Firebase handles resets on its own hosted page; nothing to do in-app.
    throw new AuthError("unknown", "Password updates happen on the Firebase reset page");
  },

  async signOut() {
    await fbSignOut(auth);
  },

  async updateDisplayName(name) {
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in");
    await updateProfile(user, { displayName: name.trim() });
    await upsertUserDoc(user);
  },

  subscribeLatestPosts(viewerId, limit, sub) {
    // Ask for one extra document to know whether another page exists.
    const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), qLimit(limit + 1));
    // If only the (empty) local cache answers for a while, report it rather than spin forever.
    let delivered = false;
    const timeout = setTimeout(() => {
      if (!delivered) sub.onError(Object.assign(new Error("Timed out waiting for posts"), { code: "unavailable" }));
    }, SERVER_WAIT_MS);
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.empty && snap.metadata.fromCache) return; // wait for the server before saying "empty"
        delivered = true;
        clearTimeout(timeout);
        const docs = snap.docs.slice(0, limit);
        sub.onData({
          posts: docs.map((d) => postFromLegacy(d.id, d.data({ serverTimestamps: "estimate" }) as LegacyPostDoc, viewerId)),
          hasMore: snap.docs.length > limit,
        });
      },
      (err) => {
        clearTimeout(timeout);
        sub.onError(err);
      },
    );
    return () => {
      clearTimeout(timeout);
      unsub();
    };
  },

  subscribePost(postId, viewerId, sub) {
    return onSnapshot(
      doc(db, "posts", postId),
      { includeMetadataChanges: true },
      (snap) =>
        !(snap.metadata.fromCache && !snap.exists()) &&
        sub.onData(snap.exists() ? postFromLegacy(snap.id, snap.data({ serverTimestamps: "estimate" }) as LegacyPostDoc, viewerId) : null),
      (err) => sub.onError(err),
    );
  },

  async createPost(viewer, input) {
    // Same shape the prototype wrote, so old and new posts stay interchangeable.
    await addDoc(collection(db, "posts"), {
      text: input.text.trim(),
      authorId: viewer.id,
      authorName: viewer.name,
      createdAt: serverTimestamp(),
      reactions: { ...EMPTY_REACTIONS },
      reacted: {},
      commentsCount: 0,
      imageDataUrl: input.image?.dataUrl ?? null,
      ...(input.image ? { imageWidth: input.image.width, imageHeight: input.image.height } : {}),
    });
  },

  async setLiked(postId, viewerId, liked) {
    const ref = doc(db, "posts", postId);
    // Transaction so a double tap or two devices can't double-count.
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data() as LegacyPostDoc;
      const already = (data.reacted?.[LIKE_REACTION] ?? []).includes(viewerId);
      if (already === liked) return;
      tx.update(ref, {
        [`reactions.${LIKE_REACTION}`]: increment(liked ? 1 : -1),
        [`reacted.${LIKE_REACTION}`]: liked ? arrayUnion(viewerId) : arrayRemove(viewerId),
      });
    });
  },

  subscribeReplies(postId, sub) {
    const q = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) =>
        !(snap.empty && snap.metadata.fromCache) &&
        sub.onData(
          snap.docs.map((d) => replyFromLegacy(postId, d.id, d.data({ serverTimestamps: "estimate" }) as LegacyCommentDoc)),
        ),
      (err) => sub.onError(err),
    );
  },

  async addReply(postId, viewer, text) {
    await addDoc(collection(db, "posts", postId, "comments"), {
      text: text.trim(),
      authorId: viewer.id,
      authorName: viewer.name,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "posts", postId), { commentsCount: increment(1) });
  },

  async getFollowingIds(viewerId) {
    const snap = await getDocs(collection(db, "users", viewerId, "following"));
    return new Set(snap.docs.map((d) => d.id));
  },

  async getPeopleSuggestions(viewerId, max) {
    const [following, snap] = await Promise.all([
      this.getFollowingIds(viewerId),
      getDocs(query(collection(db, "users"), qLimit(max + 40))),
    ]);
    const people: PersonSummary[] = [];
    snap.forEach((d) => {
      if (d.id === viewerId || following.has(d.id)) return;
      const data = d.data() as { displayName?: string; avatarUrl?: string | null };
      const name = data.displayName?.trim() || "Amigo";
      people.push({ id: d.id, name, handle: toHandle(name), avatarUrl: data.avatarUrl ?? null, viewerFollows: false });
    });
    return people.slice(0, max);
  },

  async follow(viewerId, targetId) {
    await Promise.all([
      setDoc(doc(db, "users", viewerId, "following", targetId), { followedAt: serverTimestamp() }),
      setDoc(doc(db, "users", targetId, "followers", viewerId), { followedAt: serverTimestamp() }),
    ]);
  },

  async unfollow(viewerId, targetId) {
    await Promise.all([
      deleteDoc(doc(db, "users", viewerId, "following", targetId)),
      deleteDoc(doc(db, "users", targetId, "followers", viewerId)),
    ]);
  },
};
