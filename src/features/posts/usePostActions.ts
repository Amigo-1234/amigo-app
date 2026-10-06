import { useCallback, useState } from "react";
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

  const toggle = useCallback(async () => {
    const next = !liked;
    setOptimistic(next);
    try {
      await dataSource.setLiked(post.id, viewer.id, next);
    } catch (e) {
      console.error(e);
      toast(next ? "Couldn't like that post. Try again." : "Couldn't remove your like. Try again.", "error");
    } finally {
      setOptimistic(null);
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
