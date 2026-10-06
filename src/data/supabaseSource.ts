/**
 * Supabase implementation of the app's DataSource.
 *
 * Screens never import this file; they use the DataSource interface. All
 * reads go through RLS-protected tables or SECURITY INVOKER functions, and
 * all multi-row writes through the RPCs in supabase/migrations.
 *
 * Realtime: one channel per open feed/post, listening to `posts` changes
 * only. Likes and replies arrive as counter updates on the post row, so we
 * never subscribe to the likes firehose.
 */
import type { AuthError as SupabaseAuthError, RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase/client";
import * as q from "./supabase/queries";
import { AuthError, ProfileError, type AuthErrorCode, type DataSource, type FeedScope, type Subscription, type Viewer } from "./types";

const REFRESH_DEBOUNCE_MS = 250;

// -------------------------------------------------------- local invalidation
// After our own writes, refresh open views immediately instead of waiting for
// the realtime round trip.

const invalidators = new Set<() => void>();
const invalidate = () => invalidators.forEach((fn) => fn());

/** Debounced live query: fetch now, refetch on realtime events / local writes. */
function liveQuery<T>(
  name: string,
  fetcher: () => Promise<T>,
  sub: Subscription<T>,
  listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel,
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;

  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const value = await fetcher();
      if (active) sub.onData(value);
    } catch (e) {
      if (active) sub.onError(e as Error);
    } finally {
      running = false;
      if (again && active) { again = false; void run(); }
    }
  };
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(run, REFRESH_DEBOUNCE_MS);
  };

  void run();
  const channel = listen(supabase.channel(`${name}:${crypto.randomUUID()}`), refresh).subscribe();
  invalidators.add(refresh);
  return () => {
    active = false;
    clearTimeout(timer);
    invalidators.delete(refresh);
    void supabase.removeChannel(channel);
  };
}

// --------------------------------------------------------------------- auth

const AUTH_CODES: Record<string, AuthErrorCode> = {
  invalid_credentials: "invalid-credentials",
  user_already_exists: "email-in-use",
  email_exists: "email-in-use",
  weak_password: "weak-password",
  email_address_invalid: "invalid-email",
  validation_failed: "invalid-email",
  email_not_confirmed: "email-not-confirmed",
  over_request_rate_limit: "rate-limited",
  over_email_send_rate_limit: "rate-limited",
};

function authError(e: SupabaseAuthError | Error): AuthError {
  const code = (e as SupabaseAuthError).code ?? "";
  if (/fetch|network/i.test(e.message) && !code) return new AuthError("network", e.message);
  return new AuthError(AUTH_CODES[code] ?? "unknown", e.message);
}

const LEGACY_SIGNIN = import.meta.env.VITE_LEGACY_SIGNIN === "true";

/**
 * People migrated from Firebase have no Supabase password yet. If a normal
 * sign-in fails, ask the legacy-sign-in function to verify the password
 * against Firebase; on success it sets it as their Supabase password.
 */
async function tryLegacySignIn(email: string, password: string): Promise<boolean> {
  if (!LEGACY_SIGNIN) return false;
  const { data, error } = await supabase.functions.invoke<{ status: string }>("legacy-sign-in", { body: { email, password } });
  if (data?.status === "migrated") return true;
  // 429 from the bridge: surface it rather than claiming the password is wrong.
  const status = (error as { context?: { status?: number } } | null)?.context?.status;
  if (status === 429) throw new AuthError("rate-limited");
  return false;
}

async function loadViewer(user: { id: string; email?: string | null }): Promise<Viewer> {
  // The profile row is created by a trigger in the same transaction as the user.
  const data = await q.fetchProfile(supabase, user.id).catch(() => null);
  return {
    id: user.id,
    name: data?.display_name ?? "Amigo",
    handle: data?.username ?? "amigo",
    email: user.email ?? null,
    avatarUrl: data?.avatar_url ?? null,
  };
}

const viewerListeners = new Set<(v: Viewer | null) => void>();
const recoveryListeners = new Set<() => void>();
let currentUser: { id: string; email?: string | null } | null = null;

async function emitViewer() {
  const v = currentUser ? await loadViewer(currentUser) : null;
  viewerListeners.forEach((cb) => cb(v));
}

supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user ?? null;
  const changed = next?.id !== currentUser?.id || event === "USER_UPDATED" || event === "INITIAL_SESSION";
  currentUser = next;
  if (event === "PASSWORD_RECOVERY") recoveryListeners.forEach((cb) => cb());
  // Supabase recommends not awaiting other client calls inside this callback.
  if (changed) setTimeout(() => void emitViewer(), 0);
});

// ------------------------------------------------------------------- source

export const supabaseSource: DataSource = {
  kind: "supabase",

  onViewerChanged(cb) {
    viewerListeners.add(cb);
    // Late subscribers get the current state once the initial session is known.
    void supabase.auth.getSession().then(({ data }) => {
      currentUser = data.session?.user ?? null;
      return currentUser ? loadViewer(currentUser).then(cb) : cb(null);
    });
    return () => viewerListeners.delete(cb);
  },

  onPasswordRecovery(cb) {
    recoveryListeners.add(cb);
    return () => recoveryListeners.delete(cb);
  },

  async signIn(email, password) {
    const first = await supabase.auth.signInWithPassword({ email, password });
    if (!first.error) return;
    if ((first.error as SupabaseAuthError).code === "invalid_credentials" && (await tryLegacySignIn(email, password))) {
      const second = await supabase.auth.signInWithPassword({ email, password });
      if (!second.error) return;
      throw authError(second.error);
    }
    throw authError(first.error);
  },

  async signUp(email, password, name) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name.trim() }, emailRedirectTo: `${location.origin}/` },
    });
    if (error) throw authError(error);
    // With confirmations on, Supabase returns a user with no identities for an
    // already-registered email (to avoid leaking which emails exist).
    return { needsEmailConfirmation: !data.session };
  },

  async sendPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
    if (error) throw authError(error);
  },

  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw authError(error);
  },

  async signOut() {
    await supabase.auth.signOut();
  },

  async updateDisplayName(name) {
    if (!currentUser) throw new Error("Not signed in");
    await q.updateDisplayName(supabase, currentUser.id, name);
    await emitViewer();
  },

  subscribeLatestPosts(viewerId, limit, sub, scope: FeedScope = "latest") {
    return liveQuery(
      `feed:${scope}`,
      () => q.fetchFeed(supabase, scope, limit, viewerId),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts" }, refresh),
    );
  },

  subscribePost(postId, viewerId, sub) {
    return liveQuery(
      `post:${postId}`,
      () => q.fetchPost(supabase, postId, viewerId),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `id=eq.${postId}` }, refresh),
    );
  },

  async createPost(viewer, input) {
    let uploadedPath: string | null = null;
    const media: q.NewMedia[] = [];
    if (input.image) {
      const blob = await (await fetch(input.image.dataUrl)).blob();
      const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      uploadedPath = `${viewer.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("post-media").upload(uploadedPath, blob, { contentType: blob.type, cacheControl: "31536000" });
      if (error) throw q.dataError(error);
      media.push({ kind: "image", storage_path: uploadedPath, mime_type: blob.type, width: input.image.width, height: input.image.height, byte_size: blob.size });
    }
    try {
      await q.createPost(supabase, input.text, { media });
    } catch (e) {
      // Don't leave an orphaned upload behind.
      if (uploadedPath) void supabase.storage.from("post-media").remove([uploadedPath]);
      throw e;
    }
    invalidate();
  },

  async setLiked(postId, _viewerId, liked) {
    await q.setLike(supabase, postId, liked);
    invalidate();
  },

  subscribeReplies(postId, sub) {
    return liveQuery(
      `replies:${postId}`,
      () => q.fetchReplies(supabase, postId),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `parent_id=eq.${postId}` }, refresh),
    );
  },

  async addReply(postId, _viewer, text) {
    await q.createPost(supabase, text, { parentId: postId });
    invalidate();
  },

  getFollowingIds: (viewerId) => q.fetchFollowingIds(supabase, viewerId),
  getPeopleSuggestions: (_viewerId, max) => q.fetchSuggestions(supabase, max),

  async follow(viewerId, targetId) {
    await q.follow(supabase, viewerId, targetId);
    invalidate();
  },

  async unfollow(viewerId, targetId) {
    await q.unfollow(supabase, viewerId, targetId);
    invalidate();
  },

  discovery: {
    explore: (viewerId) => q.fetchExplore(supabase, viewerId),
    searchPeople: (query, viewerId, limit) => q.searchPeople(supabase, query, viewerId, limit),
    searchPosts: (query, viewerId, opts) => q.searchPosts(supabase, query, viewerId, opts),
  },

  profiles: {
    getProfile: (handle, viewerId) => q.fetchProfileByHandle(supabase, handle, viewerId),

    subscribeProfilePosts(profileId, viewerId, tab, limit, sub) {
      return liveQuery(
        `profile:${profileId}:${tab}`,
        () => q.fetchProfilePosts(supabase, profileId, viewerId, tab, limit),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `author_id=eq.${profileId}` }, refresh),
      );
    },

    listFollows: (profileId, kind, viewerId) => q.fetchFollowList(supabase, profileId, kind, viewerId),
    isHandleAvailable: (handle, viewerId) => q.isHandleAvailable(supabase, handle, viewerId),

    async updateProfile(viewerId, update) {
      const patch: Parameters<typeof q.updateProfileRow>[2] = {};
      if (update.name !== undefined) patch.display_name = update.name.trim();
      if (update.bio !== undefined) patch.bio = update.bio.trim();
      if (update.handle !== undefined) patch.username = update.handle.toLowerCase();
      let uploaded: string | null = null;
      if (update.avatar === null) patch.avatar_url = null;
      else if (update.avatar) {
        const blob = await (await fetch(update.avatar.dataUrl)).blob();
        uploaded = `${viewerId}/${crypto.randomUUID()}.jpg`;
        const { error } = await supabase.storage.from("avatars").upload(uploaded, blob, { contentType: blob.type, cacheControl: "31536000" });
        if (error) throw new ProfileError("unknown", error.message);
        patch.avatar_url = supabase.storage.from("avatars").getPublicUrl(uploaded).data.publicUrl;
      }
      try {
        await q.updateProfileRow(supabase, viewerId, patch);
      } catch (e) {
        if (uploaded) void supabase.storage.from("avatars").remove([uploaded]);
        throw e;
      }
      await emitViewer();
      invalidate();
    },
  },
};
