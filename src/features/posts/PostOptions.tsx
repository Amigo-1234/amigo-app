import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Bookmark, Flag, Link2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { dataSource, POST_MAX_LENGTH, type ContentReportTarget, type MessageReportReason, type Post } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { REPORT_REASONS } from "../reports/reasons";

/** Optimistic bookmark toggle (backends with post tools only). */
export function useBookmark(post: Post) {
  const viewer = useViewer();
  const toast = useToast();
  const tools = dataSource.postTools;
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const saved = optimistic ?? !!post.bookmarkedByViewer;
  useEffect(() => {
    if (optimistic !== null && !!post.bookmarkedByViewer === optimistic) setOptimistic(null);
  }, [post.bookmarkedByViewer, optimistic]);
  const toggle = async () => {
    if (!tools) return;
    const next = !saved;
    setOptimistic(next);
    try {
      await tools.setBookmarked(viewer.id, post.id, next);
      toast(next ? "Saved to your bookmarks" : "Removed from bookmarks");
    } catch {
      setOptimistic(null);
      toast("Couldn't update your bookmarks. Try again.", "error");
    }
  };
  return { available: !!tools && post.bookmarkedByViewer !== undefined, saved, toggle };
}

type Sheet_ = null | "menu" | "edit" | "delete" | "report";

export function PostOptions({ post, focus }: { post: Post; focus: boolean }) {
  const viewer = useViewer();
  const toast = useToast();
  const navigate = useNavigate();
  const tools = dataSource.postTools;
  const bookmark = useBookmark(post);
  const [sheet, setSheet] = useState<Sheet_>(null);
  const mine = post.author.id === viewer.id;
  const close = () => setSheet(null);

  const copyLink = async () => {
    close();
    try {
      await navigator.clipboard.writeText(`${location.origin}/post/${post.id}`);
      toast("Link copied");
    } catch {
      toast("Couldn't copy the link", "error");
    }
  };

  return (
    <>
      <IconButton label="Post options" size="sm" className="post__options" onClick={() => setSheet("menu")}>
        <MoreHorizontal size={18} />
      </IconButton>

      <Sheet open={sheet === "menu"} onClose={close} label="Post options">
        <div className="sheet-menu">
          {bookmark.available && (
            <button
              className="sheet-menu__item"
              onClick={() => {
                close();
                void bookmark.toggle();
              }}
            >
              <Bookmark size={20} aria-hidden="true" fill={bookmark.saved ? "currentColor" : "none"} /> {bookmark.saved ? "Remove from bookmarks" : "Save to bookmarks"}
            </button>
          )}
          <button className="sheet-menu__item" onClick={copyLink}>
            <Link2 size={20} aria-hidden="true" /> Copy link
          </button>
          {tools && mine && (
            <button className="sheet-menu__item" onClick={() => setSheet("edit")}>
              <Pencil size={20} aria-hidden="true" /> Edit
            </button>
          )}
          {tools && mine && (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("delete")}>
              <Trash2 size={20} aria-hidden="true" /> Delete
            </button>
          )}
          {tools && !mine && (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("report")}>
              <Flag size={20} aria-hidden="true" /> Report {post.replyTo ? "reply" : "post"}
            </button>
          )}
          <Button variant="ghost" block onClick={close}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === "edit"} onClose={close} label="Edit post">
        {sheet === "edit" && (
          <EditPostForm
            post={post}
            onCancel={close}
            onSave={async (text) => {
              try {
                await tools!.edit(viewer.id, post.id, text);
                toast("Post updated");
                close();
              } catch {
                toast("Couldn't save your edit. Try again.", "error");
              }
            }}
          />
        )}
      </Sheet>

      <Sheet open={sheet === "delete"} onClose={close} label="Delete post">
        <ConfirmDelete
          onCancel={close}
          onConfirm={async () => {
            try {
              await tools!.remove(viewer.id, post.id);
              toast("Post deleted");
              close();
              if (focus) navigate("/", { replace: true });
            } catch {
              toast("Couldn't delete the post. Try again.", "error");
            }
          }}
        />
      </Sheet>

      <Sheet open={sheet === "report"} onClose={close} label="Report">
        {sheet === "report" && <ReportForm target="post" targetId={post.id} what={post.replyTo ? "reply" : "post"} onDone={close} />}
      </Sheet>
    </>
  );
}

function EditPostForm({ post, onSave, onCancel }: { post: Post; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(post.text);
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();
  const canSave = trimmed !== post.text.trim() && (trimmed.length > 0 || post.media.length > 0) && trimmed.length <= POST_MAX_LENGTH;
  return (
    <form
      className="sheet-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(trimmed);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="sheet-form__title">Edit post</h2>
      <label className="field">
        <span className="field__label visually-hidden">Post</span>
        <textarea className="field__input" rows={5} maxLength={POST_MAX_LENGTH} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </label>
      <p className="sheet-form__body">People will see that the post was edited.</p>
      <div className="sheet-form__actions">
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  );
}

function ConfirmDelete({ onConfirm, onCancel }: { onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Delete this post?</h2>
      <p className="sheet-form__body">It's removed for everyone, with its likes and bookmarks. This can't be undone.</p>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Report a post, profile or World to the Amigo team. */
export function ReportForm({ target, targetId, what, onDone }: { target: ContentReportTarget; targetId: string; what: string; onDone: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [reason, setReason] = useState<MessageReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Report {what}</h2>
      <fieldset className="sheet-form__choices">
        <legend className="sheet-form__body">{"What's wrong?"}</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r.id} className="choice">
            <input type="radio" name={`report-${targetId}`} checked={reason === r.id} onChange={() => setReason(r.id)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field__label">Anything else? (optional)</span>
        <textarea className="field__input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="sheet-form__body">{"Reports are private. The person you report isn't told who reported them."}</p>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={!reason}
          loading={busy}
          onClick={async () => {
            if (!reason) return;
            setBusy(true);
            try {
              await dataSource.postTools!.report(viewer.id, target, targetId, { reason, note });
              toast("Thanks — your report was sent to the Amigo team");
              onDone();
            } catch {
              toast("Couldn't send the report. Try again.", "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          Send report
        </Button>
      </div>
    </div>
  );
}

/** ⋯ on someone else's profile: copy link, report. */
export function ProfileOptions({ id, handle }: { id: string; handle: string }) {
  const toast = useToast();
  const [sheet, setSheet] = useState<null | "menu" | "report">(null);
  const close = () => setSheet(null);
  return (
    <>
      <IconButton label={`More options for @${handle}`} onClick={() => setSheet("menu")}>
        <MoreHorizontal size={20} />
      </IconButton>
      <Sheet open={sheet === "menu"} onClose={close} label="Profile options">
        <div className="sheet-menu">
          <button
            className="sheet-menu__item"
            onClick={async () => {
              close();
              try {
                await navigator.clipboard.writeText(`${location.origin}/u/${handle}`);
                toast("Link copied");
              } catch {
                toast("Couldn't copy the link", "error");
              }
            }}
          >
            <Link2 size={20} aria-hidden="true" /> Copy profile link
          </button>
          {dataSource.postTools && (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("report")}>
              <Flag size={20} aria-hidden="true" /> Report @{handle}
            </button>
          )}
          <Button variant="ghost" block onClick={close}>
            Cancel
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "report"} onClose={close} label="Report">
        {sheet === "report" && <ReportForm target="profile" targetId={id} what={`@${handle}`} onDone={close} />}
      </Sheet>
    </>
  );
}
