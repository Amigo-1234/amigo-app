import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { clearDraft, loadDraft, saveDraft } from "../features/composer/draft";
import { dataSource, type NewPostInput, type Post } from "../data";
import { limitText } from "../features/feed/errors";
import { useViewer } from "./session";
import { useToast } from "./toast";

/**
 * Optimistic publishing. publish() returns immediately: the post shows up at
 * the top of Home as "Posting…" while it uploads, becomes a normal post when
 * the backend confirms, and stays put with Retry / Discard if it fails, so
 * nothing someone wrote is ever silently lost.
 */
export interface PendingPost {
  localId: string;
  input: NewPostInput;
  /** Object URLs of the processed images, for instant display. Revoked when done. */
  previews: string[];
  status: "sending" | "failed" | "sent";
  /** Why it failed, when the server said (rate limit, suspension, upload limit). */
  error?: string;
  /** Set once stored, so screens can drop the optimistic copy when the real post arrives. */
  postId?: string;
}

interface Publishing {
  pending: PendingPost[];
  publish: (input: NewPostInput, previews: string[]) => void;
  retry: (localId: string) => void;
  discard: (localId: string) => void;
}

const PublishingContext = createContext<Publishing>({ pending: [], publish: () => {}, retry: () => {}, discard: () => {} });

/** How long a sent post's optimistic copy may linger while the feed catches up. */
const SENT_GRACE_MS = 8000;

export function PublishingProvider({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const toast = useToast();
  const [pending, setPending] = useState<PendingPost[]>([]);
  const ref = useRef(pending);
  ref.current = pending;

  const update = (localId: string, patch: Partial<PendingPost>) =>
    setPending((list) => list.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));

  const remove = useCallback((localId: string) => {
    const item = ref.current.find((p) => p.localId === localId);
    // Give any <img> still showing the preview a moment before freeing it.
    if (item) setTimeout(() => item.previews.forEach((u) => URL.revokeObjectURL(u)), 1000);
    setPending((list) => list.filter((p) => p.localId !== localId));
  }, []);

  const send = useCallback(
    async (localId: string, input: NewPostInput) => {
      update(localId, { status: "sending", error: undefined });
      try {
        const { id } = await dataSource.createPost(viewer, input);
        update(localId, { status: "sent", postId: id });
        // A draft kept from an earlier failed attempt of this post isn't needed any more.
        if (!input.world && loadDraft(viewer.id)?.text === input.text.slice(0, 2000)) clearDraft(viewer.id);
        toast("Posted");
        setTimeout(() => remove(localId), SENT_GRACE_MS);
      } catch (e) {
        console.error(e);
        const reason = limitText(e);
        update(localId, { status: "failed", error: reason ?? undefined });
        // Also keep the text as the composer's draft, so closing or reloading the app doesn't lose it.
        if (!input.world && !loadDraft(viewer.id)) saveDraft(viewer.id, input.text, input.media.length);
        toast(reason ? `${reason} Your post is saved.` : "Your post didn't go through. It's saved — tap Retry.", "error");
      }
    },
    [viewer, toast, remove],
  );

  const publish = useCallback(
    (input: NewPostInput, previews: string[]) => {
      const localId = `local-${crypto.randomUUID()}`;
      // One reference per post, reused by every retry: the server never creates it twice.
      const withRef = { ...input, clientRef: input.clientRef ?? crypto.randomUUID() };
      setPending((list) => [{ localId, input: withRef, previews, status: "sending" }, ...list]);
      void send(localId, withRef);
    },
    [send],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = ref.current.find((p) => p.localId === localId);
      if (item) void send(localId, item.input);
    },
    [send],
  );

  // Back online: send posts that failed while the connection was down (each has its client
  // reference, so a post the server already saved is returned, never created twice).
  useEffect(() => {
    const onOnline = () => ref.current.filter((p) => p.status === "failed").forEach((p) => retry(p.localId));
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [retry]);

  // Free previews if the app unmounts with posts still pending.
  useEffect(() => () => ref.current.forEach((p) => p.previews.forEach((u) => URL.revokeObjectURL(u))), []);

  return <PublishingContext.Provider value={{ pending, publish, retry, discard: remove }}>{children}</PublishingContext.Provider>;
}

export const usePublishing = () => useContext(PublishingContext);

/** Render a pending post with the normal PostCard. */
export function pendingAsPost(p: PendingPost, viewer: { id: string; name: string; handle: string; avatarUrl: string | null }): Post {
  return {
    id: p.localId,
    author: { id: viewer.id, name: viewer.name, handle: viewer.handle, avatarUrl: viewer.avatarUrl },
    text: p.input.text.trim(),
    media: p.input.media.map((m, i) => ({ type: "image", url: p.previews[i], width: m.width, height: m.height, alt: m.alt })),
    createdAt: null,
    likeCount: 0,
    likedByViewer: false,
    replyCount: 0,
  };
}
