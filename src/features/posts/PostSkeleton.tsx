import { Skeleton } from "../../ui/Skeleton";

export function PostSkeleton({ media = false }: { media?: boolean }) {
  return (
    <div className="post" aria-hidden="true">
      <div className="post__head">
        <Skeleton width={42} height={42} radius="50%" />
        <div style={{ display: "grid", gap: 6 }}>
          <Skeleton width={128} height={12} />
          <Skeleton width={84} height={10} />
        </div>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <Skeleton width="92%" height={12} />
        <Skeleton width="64%" height={12} />
      </div>
      {media && <Skeleton height={260} radius={16} style={{ marginTop: 14 }} />}
      <div style={{ display: "flex", gap: 24, margin: "16px 0 10px" }}>
        <Skeleton width={36} height={14} />
        <Skeleton width={36} height={14} />
      </div>
    </div>
  );
}

export function FeedSkeleton() {
  return (
    <div role="status" aria-label="Loading posts">
      <PostSkeleton />
      <PostSkeleton media />
      <PostSkeleton />
      <PostSkeleton media />
    </div>
  );
}
