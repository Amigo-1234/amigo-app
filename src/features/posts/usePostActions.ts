import { useCallback, useEffect, useState } from "react";
import { dataSource, type Post } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";

/** Optimistic like toggle that reconciles with the live post snapshot. */
export function useLike(post: Post) {
  const viewer = useViewer();
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  const liked = optimistic ?? post.likedByViewer;
  const delta = optimistic !== null && optimistic !== post.likedByViewer ? (optimistic ? 1 : -1) : 0;
  const count = Math.max(0, post.likeCount + delta);

  // Keep the optimistic value until the post data catches up. Live lists
  // (feeds) catch up via their subscription; one-off lists (search results,
  // Explore) never re-fetch, so clearing early would visually undo the like.
  useEffect(() => {
    if (optimistic !== null && post.likedByViewer === optimistic) setOptimistic(null);
  }, [post.likedByViewer, optimistic]);

  const toggle = useCallback(async () => {
    const next = !liked;
    setOptimistic(next);
    try {
      await dataSource.setLiked(post.id, viewer.id, next);
    } catch (e) {
      console.error(e);
      setOptimistic(null);
      toast(next ? "Couldn't like that post. Try again." : "Couldn't remove your like. Try again.", "error");
    }
  }, [liked, post.id, viewer.id, toast]);

  return { liked, count, toggle };
}

export function useSharePost() {
  const toast = useToast();
  return useCallback(
    async (post: Post) => {
      const url = `${location.origin}/post/${post.id}`;
      const data = { title: `${post.author.name} on Amigo`, text: post.text.slice(0, 120), url };
      try {
        if (navigator.share && matchMedia("(pointer: coarse)").matches) {
          await navigator.share(data);
          return;
        }
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      } catch (e) {
        if ((e as DOMException)?.name !== "AbortError") toast("Couldn't share this post", "error");
      }
    },
    [toast],
  );
}
