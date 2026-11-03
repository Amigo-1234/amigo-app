import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Search, X } from "lucide-react";
import { dataSource, type PersonSummary } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/Button";
import { VerifiedBadge } from "../../ui/VerifiedBadge";

/** Pick someone to message: people you follow, or search everyone. */
export function NewMessageSheet({ onClose }: { onClose: () => void }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const q = query.trim();

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      async () => {
        try {
          const list = q
            ? ((await dataSource.discovery?.searchPeople(q, viewer.id, 12)) ?? [])
            : ((await dataSource.profiles?.listFollows(viewer.id, "following", viewer.id)) ?? []);
          if (!cancelled) setPeople(list.filter((p) => p.id !== viewer.id));
        } catch {
          if (!cancelled) setPeople([]);
        }
      },
      q ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, viewer.id]);

  async function open(p: PersonSummary) {
    setOpening(p.id);
    try {
      const id = await dataSource.messages!.openConversation(viewer.id, p.id);
      onClose();
      navigate(`/messages/${id}`);
    } catch {
      toast(`Couldn't start a conversation with ${p.name}`, "error");
      setOpening(null);
    }
  }

  return (
    <div className="new-msg">
      <div className="new-msg__head">
        <h2 className="sheet-form__title">New message</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <label className="new-msg__search">
        <Search size={18} aria-hidden="true" />
        <span className="visually-hidden">Search people</span>
        <input autoFocus className="field__input" value={query} placeholder="Search people" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="new-msg__hint">{q ? "People" : "People you follow"}</p>
      {people === null ? (
        <p className="new-msg__empty" role="status">Loading…</p>
      ) : people.length === 0 ? (
        <p className="new-msg__empty">{q ? `No one matches “${q}”.` : "Search for someone to message."}</p>
      ) : (
        <ul className="new-msg__list">
          {people.map((p) => (
            <li key={p.id}>
              <button className="new-msg__person" onClick={() => open(p)} disabled={!!opening} aria-busy={opening === p.id || undefined}>
                <Avatar name={p.name} src={p.avatarUrl} seed={p.id} size="sm" />
                <span className="new-msg__person-text">
                  <span className="new-msg__person-name">
                    {p.name}
                    <VerifiedBadge verified={p.verified} size={14} />
                  </span>
                  <span className="new-msg__person-handle">@{p.handle}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
