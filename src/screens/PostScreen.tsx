import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { profileHref } from "../features/profile/links";
import { ArrowLeft, CircleAlert, CornerLeftUp, MessageCircle, SearchX } from "lucide-react";
import { dataSource, type Post, type Reply } from "../data";
import { POST_MAX_LENGTH } from "../features/composer/Composer";
import { describeError } from "../features/feed/errors";
import { PostCard } from "../features/posts/PostCard";
import { PostSkeleton } from "../features/posts/PostSkeleton";
import { RichText } from "../features/posts/RichText";
import { timeAgo, timeAgoLong } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./PostScreen.css";
import { VerifiedBadge } from "../ui/VerifiedBadge";

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };

export default function PostScreen() {
  const { postId = "" } = useParams();
  const viewer = useViewer();
  const navigate = useNavigate();
  const location = useLocation();
  const [post, setPost] = useState<Load<Post | null>>({ status: "loading" });
  const [replies, setReplies] = useState<Load<Reply[]>>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setPost({ status: "loading" });
    return dataSource.subscribePost(postId, viewer.id, {
      onData: (data) => setPost({ status: "ready", data }),
      onError: (error) => setPost({ status: "error", error }),
    });
  }, [postId, viewer.id, retryKey]);

  useEffect(() => {
    setReplies({ status: "loading" });
    return dataSource.subscribeReplies(postId, {
      onData: (data) => setReplies({ status: "ready", data }),
      onError: (error) => setReplies({ status: "error", error }),
    });
  }, [postId, retryKey]);

  // Arriving from a "Reply" button jumps straight to the reply box.
  const wantsReply = location.hash === "#reply";
  useEffect(() => {
    if (wantsReply && post.status === "ready" && post.data) {
      document.getElementById("reply-input")?.focus();
    }
  }, [wantsReply, post.status, post]);

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/"));

  return (
    <>
      <ScreenHeader
        title="Post"
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />

      {post.status === "loading" && <PostSkeleton media />}

      {post.status === "error" && (
        <StateMessage
          tone="error"
          icon={<CircleAlert size={24} />}
          {...describeError(post.error)}
          action={<Button variant="secondary" onClick={() => setRetryKey((k) => k + 1)}>Try again</Button>}
        />
      )}

      {post.status === "ready" && !post.data && (
        <StateMessage
          icon={<SearchX size={24} />}
          title="This post isn't available"
          body="It may have been deleted, or the link is wrong."
          action={<Button variant="secondary" onClick={() => navigate("/")}>Back to Home</Button>}
        />
      )}

      {post.status === "ready" && post.data && (
        <>
          {post.data.replyTo && (
            <Link to={`/post/${post.data.replyTo.postId}`} className="thread-up">
              <CornerLeftUp size={16} aria-hidden="true" />
              Show the post this replies to
            </Link>
          )}
          <PostCard post={post.data} variant="focus" />
          <ReplyComposer postId={post.data.id} replyingTo={post.data.author.handle} />
          <section aria-label="Replies">
            {replies.status === "loading" && <ReplySkeletons />}
            {replies.status === "error" && <p className="replies-note">Replies couldn't load right now.</p>}
            {replies.status === "ready" && replies.data.length === 0 && (
              <StateMessage icon={<MessageCircle size={24} />} title="No replies yet" body="Start the conversation." />
            )}
            {replies.status === "ready" && replies.data.map((r) => <ReplyRow key={r.id} reply={r} />)}
          </section>
        </>
      )}
    </>
  );
}

function ReplyRow({ reply }: { reply: Reply }) {
  const href = profileHref(reply.author.handle);
  return (
    <article className="reply">
      {href ? (
        <Link to={href} tabIndex={-1} aria-hidden="true" className="post__avatar-link">
          <Avatar name={reply.author.name} src={reply.author.avatarUrl} seed={reply.author.id} size="sm" />
        </Link>
      ) : (
        <Avatar name={reply.author.name} src={reply.author.avatarUrl} seed={reply.author.id} size="sm" />
      )}
      <div className="reply__body">
        <div className="reply__meta">
          {href ? (
            <Link to={href} className="reply__name post__name--link">{reply.author.name}<VerifiedBadge verified={reply.author.verified} size={14} /></Link>
          ) : (
            <span className="reply__name">{reply.author.name}<VerifiedBadge verified={reply.author.verified} size={14} /></span>
          )}
          <span className="reply__sub">
            @{reply.author.handle} ·{" "}
            <time dateTime={reply.createdAt?.toISOString()} aria-label={timeAgoLong(reply.createdAt)}>
              {timeAgo(reply.createdAt)}
            </time>
          </span>
        </div>
        <p className="reply__text">
          <RichText text={reply.text} />
        </p>
      </div>
    </article>
  );
}

function ReplySkeletons() {
  return (
    <div role="status" aria-label="Loading replies">
      {[0, 1, 2].map((i) => (
        <div key={i} className="reply" aria-hidden="true">
          <Skeleton width={32} height={32} radius="50%" />
          <div className="reply__body" style={{ display: "grid", gap: 8 }}>
            <Skeleton width={140} height={11} />
            <Skeleton width="80%" height={11} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplyComposer({ postId, replyingTo }: { postId: string; replyingTo: string }) {
  const viewer = useViewer();
  const labelId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= POST_MAX_LENGTH && !sending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await dataSource.addReply(postId, viewer, trimmed);
      setText("");
    } catch (err) {
      console.error(err);
      setError("Your reply didn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="reply-composer" onSubmit={submit} aria-labelledby={labelId}>
      <span id={labelId} className="visually-hidden">
        Reply to @{replyingTo}
      </span>
      <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="sm" />
      <div className="reply-composer__field">
        <input
          id="reply-input"
          className="reply-composer__input"
          placeholder={`Reply to @${replyingTo}`}
          value={text}
          maxLength={POST_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
          autoComplete="off"
        />
        {error && (
          <p className="reply-composer__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="sm" disabled={!canSend} loading={sending}>
        Reply
      </Button>
    </form>
  );
}
