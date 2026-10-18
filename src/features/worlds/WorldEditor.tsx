import { useState, type FormEvent } from "react";
import { dataSource, type World, type WorldInput } from "../../data";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { serverNow, worldStatus } from "./time";

/** "2026-10-20T18:30" in this device's time zone, for <input type="datetime-local">. */
const toLocal = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (s: string) => (s ? new Date(s) : null);
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * Create or edit a World (admins). The database re-checks everything; this
 * form explains the rules up front: once a World has started, its start time,
 * link and competition rules are fixed so nobody's entry is judged by
 * different rules than they joined under. Prizes are display text only.
 */
export function WorldEditor({ world, onDone }: { world?: World; onDone: (saved: { id: string; slug: string } | null) => void }) {
  const admin = dataSource.worlds?.admin;
  const toast = useToast();
  const started = !!world && worldStatus(world, serverNow()) !== "upcoming";
  const inHour = new Date(Math.ceil((serverNow() + 3600_000) / 900_000) * 900_000);
  const [title, setTitle] = useState(world?.title ?? "");
  const [slug, setSlug] = useState(world?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!world);
  const [tagline, setTagline] = useState(world?.tagline ?? "");
  const [description, setDescription] = useState(world?.description ?? "");
  const [coverUrl, setCoverUrl] = useState(world?.coverUrl ?? "");
  const [startsAt, setStartsAt] = useState(toLocal(world?.startsAt ?? inHour));
  const [endsAt, setEndsAt] = useState(toLocal(world?.endsAt ?? new Date(inHour.getTime() + 2 * 3600_000)));
  const [competition, setCompetition] = useState(!!world?.competition);
  const [entriesCloseAt, setEntriesCloseAt] = useState(toLocal(world?.competition?.entriesCloseAt ?? new Date(inHour.getTime() + 90 * 60_000)));
  const [entryLimit, setEntryLimit] = useState(world?.competition?.entryLimit ?? 1);
  const [reaction, setReaction] = useState(world?.competition?.scoring.reaction ?? 1);
  const [reply, setReply] = useState(world?.competition?.scoring.reply ?? 2);
  const [hostPick, setHostPick] = useState(world?.competition?.scoring.hostPick ?? 10);
  const [prize, setPrize] = useState(world?.competition?.prize ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!admin) return null;

  function check(): WorldInput | string {
    const s = fromLocal(startsAt);
    const e = fromLocal(endsAt);
    const c = fromLocal(entriesCloseAt);
    if (!title.trim()) return "Give the World a title.";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 3) return "The link needs at least 3 letters or numbers (a–z, 0–9, dashes).";
    if (!s || !e) return "Set when it starts and ends.";
    if (e <= s) return "It has to end after it starts.";
    if (e.getTime() <= serverNow()) return "The end has to be in the future.";
    if (coverUrl && !/^https:\/\//.test(coverUrl)) return "The cover image must be an https:// link.";
    if (competition) {
      if (!c || c <= s || c > e) return "Entries must close after the start and no later than the end.";
      if (entryLimit < 1 || entryLimit > 10) return "Entries per person: 1 to 10.";
    }
    return {
      slug,
      title: title.trim(),
      tagline: tagline.trim(),
      description: description.trim(),
      coverUrl: coverUrl.trim() || null,
      startsAt: s,
      endsAt: e,
      competition: competition
        ? { entriesCloseAt: c!, entryLimit, scoring: { reaction, reply, hostPick }, prize: prize.trim() || null }
        : null,
    };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const input = check();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    setError(null);
    try {
      if (world) {
        // Only what changed (a started World refuses changes to its fixed parts).
        const patch: Partial<WorldInput> = {};
        if (input.title !== world.title) patch.title = input.title;
        if (input.tagline !== world.tagline) patch.tagline = input.tagline;
        if (input.description !== world.description) patch.description = input.description;
        if ((input.coverUrl ?? null) !== (world.coverUrl ?? null)) patch.coverUrl = input.coverUrl;
        if (input.endsAt.getTime() !== world.endsAt.getTime()) patch.endsAt = input.endsAt;
        if (!started) {
          if (input.slug !== world.slug) patch.slug = input.slug;
          if (input.startsAt.getTime() !== world.startsAt.getTime()) patch.startsAt = input.startsAt;
          patch.competition = input.competition;
        } else if (input.competition && world.competition && input.competition.entriesCloseAt.getTime() !== world.competition.entriesCloseAt.getTime()) {
          patch.competition = { ...input.competition, entryLimit: world.competition.entryLimit, scoring: world.competition.scoring };
        }
        await admin!.update(world.id, patch);
        toast("World updated");
        onDone({ id: world.id, slug: input.slug });
      } else {
        const { id } = await admin!.create(input);
        toast("World created");
        onDone({ id, slug: input.slug });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sheet-form world-editor" onSubmit={save}>
      <h2 className="sheet-form__title">{world ? "Edit World" : "New World"}</h2>
      {started && <p className="sheet-form__body">This World has started: its start time, link and competition rules are fixed. You can still change the text, cover and end time.</p>}
      <label className="field">
        <span className="field__label">Title</span>
        <input
          className="field__input"
          value={title}
          maxLength={80}
          required
          onChange={(e) => {
            setTitle(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">Link: /worlds/{slug || "…"}</span>
        <input
          className="field__input"
          value={slug}
          disabled={started}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">Tagline</span>
        <input className="field__input" value={tagline} maxLength={140} onChange={(e) => setTagline(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Description</span>
        <textarea className="field__input" rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Cover image (optional, https:// link)</span>
        <input className="field__input" type="url" inputMode="url" value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://…" />
      </label>
      <div className="world-editor__times">
        <label className="field">
          <span className="field__label">Starts</span>
          <input className="field__input" type="datetime-local" value={startsAt} disabled={started} onChange={(e) => setStartsAt(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label">Ends</span>
          <input className="field__input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
        </label>
      </div>
      <p className="world-editor__hint">Times are in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Everyone sees them in theirs; the World opens and closes on the server's clock.</p>

      <label className="choice">
        <input type="checkbox" checked={competition} disabled={started} onChange={(e) => setCompetition(e.target.checked)} />
        Competition with a leaderboard
      </label>
      {competition && (
        <fieldset className="world-editor__comp">
          <label className="field">
            <span className="field__label">Entries close</span>
            <input className="field__input" type="datetime-local" value={entriesCloseAt} onChange={(e) => setEntriesCloseAt(e.target.value)} />
          </label>
          <div className="world-editor__nums">
            <label className="field">
              <span className="field__label">Entries each</span>
              <input className="field__input" type="number" min={1} max={10} value={entryLimit} disabled={started} onChange={(e) => setEntryLimit(Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="field__label">Points / like</span>
              <input className="field__input" type="number" min={0} max={100} value={reaction} disabled={started} onChange={(e) => setReaction(Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="field__label">Points / reply</span>
              <input className="field__input" type="number" min={0} max={100} value={reply} disabled={started} onChange={(e) => setReply(Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="field__label">Amigo pick bonus</span>
              <input className="field__input" type="number" min={0} max={1000} value={hostPick} disabled={started} onChange={(e) => setHostPick(Number(e.target.value))} />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Prize (display text only — Amigo doesn't handle payments)</span>
            <input className="field__input" value={prize} maxLength={280} onChange={(e) => setPrize(e.target.value)} placeholder="e.g. Featured on the Amigo home page" />
          </label>
        </fieldset>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {world ? "Save changes" : "Create World"}
        </Button>
      </div>
    </form>
  );
}

/** Cancel a World that hasn't finished: members are told (notice + push). */
export function CancelWorld({ world, onDone }: { world: World; onDone: (cancelled: boolean) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Cancel {world.title}?</h2>
      <p className="sheet-form__body">
        No one can join, post or chat in it after this. Its {world.participantCount} {world.participantCount === 1 ? "member is" : "members are"} told. This can't be undone.
      </p>
      <label className="field">
        <span className="field__label">Reason (shown to members, optional)</span>
        <input className="field__input" value={reason} maxLength={280} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={() => onDone(false)}>
          Keep it
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await dataSource.worlds!.admin!.cancel(world.id, reason.trim());
              toast("World cancelled — members have been told");
              onDone(true);
            } catch (e) {
              toast(e instanceof Error ? e.message : "Couldn't cancel it. Try again.", "error");
              setBusy(false);
            }
          }}
        >
          Cancel World
        </Button>
      </div>
    </div>
  );
}
