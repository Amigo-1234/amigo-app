import { memo, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Heart, MessageCircle, Share } from "lucide-react";
import type { Post } from "../../data";
import { Avatar } from "../../ui/Avatar";
import { formatCount } from "../../lib/format";
import { fullTimestamp, timeAgo, timeAgoLong } from "../../lib/time";
import { PostMedia } from "./PostMedia";
import { RichText } from "./RichText";
import { useMediaViewer } from "./MediaViewer";
import { useLike, useSharePost } from "./usePostActions";
import { profileHref } from "../profile/links";
import "./PostCard.css";

const COLLAPSE_AT = 480;

/** Short, text-only posts get set in display type — Amigo's "statement" post. */
function isStatement(post: Post) {
  return !post.replyTo && post.media.length === 0 && post.text.length > 0 && post.text.length <= 90 && !post.text.includes("\n");
}

const INTERACTIVE = "a, button, video, input, textarea, [role='button']";

export const PostCard = memo(function PostCard({ post, variant = "feed" }: { post: Post; variant?: "feed" | "focus" }) {
  const navigate = useNavigate();
  const openMedia = useMediaViewer();
  const share = useSharePost();
  const { liked, count, toggle } = useLike(post);
  const [expanded, setExpanded] = useState(false);

  const focus = variant === "focus";
  const href = `/post/${post.id}`;
  const longText = !focus && !expanded && post.text.length > COLLAPSE_AT;
  const text = longText ? post.text.slice(0, COLLAPSE_AT).trimEnd() + "…" : post.text;
  const nameId = `post-${post.id}-author`;
  const authorHref = profileHref(post.author.handle);
  const replyToHref = post.replyTo ? profileHref(post.replyTo.handle) : null;

  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if (focus) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // let people select text
    navigate(href);
  };

  return (
    <article className={`post post--${variant}`} aria-labelledby={nameId} onClick={onCardClick}>
      <header className="post__head">
        {authorHref ? (
          <Link to={authorHref} className="post__avatar-link" tabIndex={-1} aria-hidden="true">
            <Avatar name={post.author.name} src={post.author.avatarUrl} seed={post.author.id} size={focus ? "lg" : "md"} />
          </Link>
        ) : (
          <Avatar name={post.author.name} src={post.author.avatarUrl} seed={post.author.id} size={focus ? "lg" : "md"} />
        )}
        <div className="post__byline">
          {authorHref ? (
            <Link to={authorHref} className="post__name post__name--link" id={nameId}>
              {post.author.name}
            </Link>
          ) : (
            <span className="post__name" id={nameId}>
              {post.author.name}
            </span>
          )}
          <span className="post__meta">
            <span className="post__handle">@{post.author.handle}</span>
            {!focus && (
              <>
                <span aria-hidden="true"> · </span>
                <Link to={href} className="post__time" title={fullTimestamp(post.createdAt)}>
                  <time dateTime={post.createdAt?.toISOString()} aria-label={timeAgoLong(post.createdAt)}>
                    {timeAgo(post.createdAt)}
                  </time>
                </Link>
              </>
            )}
          </span>
        </div>
      </header>

      {post.replyTo && (
        <p className="post__reply-to">
          Replying to{" "}
          {replyToHref ? <Link to={replyToHref}>@{post.replyTo.handle}</Link> : <span>@{post.replyTo.handle}</span>}
        </p>
      )}

      {post.text && (
        <div className={`post__text${isStatement(post) ? " post__text--statement" : ""}`}>
          <RichText text={text} />
          {longText && (
            <button className="post__more" onClick={() => setExpanded(true)}>
              Show more
            </button>
          )}
        </div>
      )}

      <PostMedia media={post.media} onOpen={(i) => openMedia(post.media[i])} />

      {focus && (
        <p className="post__timestamp">
          <time dateTime={post.createdAt?.toISOString()}>{fullTimestamp(post.createdAt)}</time>
        </p>
      )}

      <footer className="post__actions">
        <button
          className={`action action--like${liked ? " is-active" : ""}`}
          onClick={toggle}
          aria-pressed={liked}
          aria-label={`${liked ? "Unlike" : "Like"}. ${count} ${count === 1 ? "like" : "likes"}`}
        >
          <Heart size={20} strokeWidth={1.9} fill={liked ? "currentColor" : "none"} aria-hidden="true" />
          <span className="action__count">{count > 0 ? formatCount(count) : ""}</span>
        </button>

        <Link
          to={focus ? "#reply" : `${href}#reply`}
          className="action action--reply"
          aria-label={`Reply. ${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}`}
          onClick={(e) => {
            if (!focus) return;
            e.preventDefault();
            document.getElementById("reply-input")?.focus();
          }}
        >
          <MessageCircle size={20} strokeWidth={1.9} aria-hidden="true" />
          <span className="action__count">{post.replyCount > 0 ? formatCount(post.replyCount) : ""}</span>
        </Link>

        <button className="action action--share" onClick={() => share(post)} aria-label="Share">
          <Share size={19} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
});
