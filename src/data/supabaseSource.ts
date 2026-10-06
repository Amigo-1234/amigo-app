/**
 * Supabase implementation of the app's DataSource.
 *
 * Screens never import this file; they use the DataSource interface. All
 * reads go through RLS-protected tables or SECURITY INVOKER functions, and
 * all multi-row writes through the RPCs in supabase/migrations.
 *
 * Realtime: one channel per open feed/post, listening to `posts` changes
 * only. Likes and replies arrive as counter updates on the post row, so we
 * never subscribe to the likes firehose. Notifications listen to the
 * viewer's own `notifications` rows (Realtime applies RLS, so nobody receives
 * anyone else's).
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
  // post_media.position is 0–3 and create_post rejects more than 4.
  maxMediaPerPost: 4,

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
    if (input.media.length > supabaseSource.maxMediaPerPost) throw new Error(`At most ${supabaseSource.maxMediaPerPost} images per post`);
    // Upload in parallel, keep the composer's order. Paths live in the author's own folder (Storage RLS).
    const uploads = await Promise.allSettled(
      input.media.map(async (m) => {
        const ext = m.blob.type === "image/png" ? "png" : m.blob.type === "image/webp" ? "webp" : m.blob.type === "image/gif" ? "gif" : "jpg";
        const path = `${viewer.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from("post-media").upload(path, m.blob, { contentType: m.blob.type, cacheControl: "31536000" });
        if (error) throw q.dataError(error);
        return { kind: "image" as const, storage_path: path, mime_type: m.blob.type, width: m.width, height: m.height, byte_size: m.blob.size };
      }),
    );
    const uploaded = uploads.flatMap((u) => (u.status === "fulfilled" ? [u.value] : []));
    const cleanup = () => uploaded.length && void supabase.storage.from("post-media").remove(uploaded.map((u) => u.storage_path));
    const failed = uploads.find((u) => u.status === "rejected");
    if (failed) {
      cleanup();
      throw (failed as PromiseRejectedResult).reason;
    }
    let created: { id: string };
    try {
      // One transaction: the post and all its post_media rows, in order.
      created = input.world
        ? await q.createWorldPost(supabase, input.world.id, input.world.entry, input.text, uploaded)
        : await q.createPost(supabase, input.text, { media: uploaded });
    } catch (e) {
      cleanup(); // don't leave orphaned uploads behind
      throw e;
    }
    invalidate();
    return { id: created.id };
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

  worlds: {
    listWorlds: (viewerId) => q.fetchWorlds(supabase, viewerId),

    subscribeWorld(slug, viewerId, sub) {
      return liveQuery(
        `world:${slug}`,
        () => q.fetchWorld(supabase, slug, viewerId),
        sub,
        // participant_count changes arrive as updates on the worlds row.
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "worlds", filter: `slug=eq.${slug}` }, refresh),
      );
    },

    async join(worldId, viewerId) {
      await q.joinWorld(supabase, worldId, viewerId);
      invalidate();
    },

    async leave(worldId, viewerId) {
      await q.leaveWorld(supabase, worldId, viewerId);
      invalidate();
    },

    subscribeWorldPosts(worldId, viewerId, opts, sub) {
      return liveQuery(
        `world-posts:${worldId}:${opts.entriesOnly}`,
        () => q.fetchWorldPosts(supabase, worldId, viewerId, opts),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `world_id=eq.${worldId}` }, refresh),
      );
    },

    subscribeLeaderboard(worldId, viewerId, sub) {
      return liveQuery(
        `world-board:${worldId}`,
        () => q.fetchLeaderboard(supabase, worldId, viewerId),
        sub,
        // Scores move with likes/replies, which surface as counter updates on the World's posts.
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `world_id=eq.${worldId}` }, refresh),
      );
    },

    subscribeChat(worldId, limit, sub) {
      return liveQuery(
        `world-chat:${worldId}`,
        () => q.fetchChat(supabase, worldId, limit),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "world_chat_messages", filter: `world_id=eq.${worldId}` }, refresh),
      );
    },

    async sendChat(worldId, _viewer, text) {
      await q.sendChat(supabase, worldId, text);
      invalidate();
    },

    listParticipants: (worldId, viewerId, limit) => q.fetchParticipants(supabase, worldId, viewerId, limit),
  },

  support: {
    config: () => q.fetchSupportConfig(supabase),
    wallet: () => q.fetchWallet(supabase),

    subscribeRequests(viewerId, opts, sub) {
      return liveQuery(
        `support:${opts.section}:${opts.category ?? ""}`,
        () => q.fetchSupportRequests(supabase, viewerId, opts),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "support_requests" }, refresh),
      );
    },

    subscribeRequest(id, viewerId, sub) {
      return liveQuery(
        `support:${id}`,
        () => q.fetchSupportRequest(supabase, id, viewerId),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "support_requests", filter: `id=eq.${id}` }, refresh),
      );
    },

    async createRequest(_viewerId, input) {
      const res = await q.createSupportRequest(supabase, input);
      invalidate();
      return res;
    },
    async openSupport(requestId) {
      await q.openSupport(supabase, requestId);
      invalidate();
    },
    async confirmSupport(requestId) {
      const res = await q.confirmSupport(supabase, requestId);
      invalidate();
      return res;
    },
    async leaveFeedback(requestId, _viewerId, { reaction, text }) {
      const res = await q.leaveFeedback(supabase, requestId, reaction, text);
      invalidate();
      return res;
    },
    listFeedback: (requestId) => q.fetchFeedback(supabase, requestId),
    report: (requestId, _viewerId, reason) => q.reportSupport(supabase, requestId, reason),
    profileStats: (profileId) => q.fetchSupportProfileStats(supabase, profileId),
  },

  // The admin UI is only a convenience: every call below is re-checked by is_admin() in the database.
  admin: {
    isAdmin: () => q.fetchIsAdmin(supabase),
    support: {
      listRequests: (adminId, status) => q.adminListRequests(supabase, adminId, status),
      async moderate(_adminId, requestId, action, note) {
        await q.adminModerate(supabase, requestId, action, note);
        invalidate();
      },
      listReports: (_adminId, status) => q.adminReports(supabase, status),
      resolveReport: (_adminId, reportId, outcome) => q.adminResolveReport(supabase, reportId, outcome),
      suspicious: () => q.adminSuspicious(supabase),
      supporters: (_adminId, requestId) => q.adminSupporters(supabase, requestId),
      findUser: (adminId, handle) => q.adminFindUser(supabase, adminId, handle),
      adjustCredits: (_adminId, userId, delta, note) => q.adminAdjustCredits(supabase, userId, delta, note),
      audit: (_adminId, limit) => q.adminAudit(supabase, limit),
    },
    users: {
      find: (adminId, handle) => q.adminFindUserProfile(supabase, adminId, handle),
      async verify(_adminId, userId, type, note) {
        await q.adminVerify(supabase, userId, type, note);
        invalidate();
      },
      async unverify(_adminId, userId, note) {
        await q.adminUnverify(supabase, userId, note);
        invalidate();
      },
      listVerified: (adminId) => q.adminVerifiedUsers(supabase, adminId),
    },
  },

  notifications: {
    subscribeNotifications(viewerId, limit, sub) {
      return liveQuery(
        "notifications",
        () => q.fetchNotifications(supabase, limit),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${viewerId}` }, refresh),
      );
    },

    subscribeUnreadCount(viewerId, sub) {
      return liveQuery(
        "notifications:unread",
        () => q.fetchUnreadCount(supabase),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${viewerId}` }, refresh),
      );
    },

    async markRead(_viewerId, ids) {
      await q.markNotificationsRead(supabase, ids);
      invalidate();
    },

    async markAllRead() {
      await q.markNotificationsRead(supabase);
      invalidate();
    },
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
