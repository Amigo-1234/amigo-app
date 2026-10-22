import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Bookmark, CircleAlert } from "lucide-react";
import { dataSource, type Post } from "../data";
import { PostCard } from "../features/posts/PostCard";
import { PostSkeleton } from "../features/posts/PostSkeleton";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";

const LIMIT = 100;

/** Your saved posts. Only you can see them. */
export default function BookmarksScreen() {
  const navigate = useNavigate();
  const viewer = useViewer();
  const tools = dataSource.postTools;
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    if (!tools) return;
    setFailed(false);
    tools.bookmarks(viewer.id, LIMIT).then(setPosts, () => setFailed(true));
  }, [tools, viewer.id]);
  useEffect(load, [load]);

  const shown = posts;

  return (
    <>
      <ScreenHeader
        title="Bookmarks"
        leading={
          <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {failed ? (
        <StateMessage
          tone="error"
          icon={<CircleAlert size={24} />}
          title="Couldn't load your bookmarks"
          body="Check your connection and try again."
          action={<Button variant="secondary" onClick={load}>Try again</Button>}
        />
      ) : !shown ? (
        <div aria-busy="true" aria-label="Loading bookmarks">
          <PostSkeleton />
          <PostSkeleton />
        </div>
      ) : shown.length === 0 ? (
        <StateMessage icon={<Bookmark size={24} />} title="No bookmarks yet" body="Tap the bookmark on any post to save it here. Only you can see what you save." />
      ) : (
        <div className="feed">
          {shown.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </div>
      )}
    </>
  );
}
