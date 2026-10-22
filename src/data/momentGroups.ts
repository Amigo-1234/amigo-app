import type { Moment, MomentGroup } from "./types";

/**
 * Groups visible Moments by person for the Home row and the viewer: you
 * first, then people with something you haven't seen, newest activity first.
 * Each person's Moments play oldest first. Shared by every backend.
 */
export function groupMoments(moments: Moment[], viewerId: string): MomentGroup[] {
  const byAuthor = new Map<string, Moment[]>();
  for (const m of moments) byAuthor.set(m.author.id, [...(byAuthor.get(m.author.id) ?? []), m]);
  const groups = [...byAuthor.values()].map((list): MomentGroup => {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { author: sorted[0].author, moments: sorted, hasUnseen: sorted.some((m) => !m.seen), isViewer: sorted[0].author.id === viewerId };
  });
  const latest = (g: MomentGroup) => g.moments[g.moments.length - 1].createdAt.getTime();
  return groups.sort((a, b) => Number(b.isViewer) - Number(a.isViewer) || Number(b.hasUnseen) - Number(a.hasUnseen) || latest(b) - latest(a));
}
