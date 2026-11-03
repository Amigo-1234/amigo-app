import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Ban, CircleAlert } from "lucide-react";
import { dataSource, type BlockedAccount } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

/** Settings → Blocked accounts. Only you see this list; people aren't told they're blocked. */
export default function BlockedScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const api = dataSource.blocking;
  const [rows, setRows] = useState<BlockedAccount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!api) return;
    setFailed(false);
    api.list().then(setRows, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  return (
    <>
      <ScreenHeader
        title="Blocked accounts"
        leading={
          <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {failed ? (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} title="Couldn't load blocked accounts" body="Try again." action={<Button variant="secondary" onClick={load}>Try again</Button>} />
      ) : !rows ? (
        <p className="settings-muted" aria-busy="true">Loading…</p>
      ) : rows.length === 0 ? (
        <StateMessage icon={<Ban size={24} />} title="You haven't blocked anyone" body="Block someone from their profile, a post or a conversation. They aren't told." />
      ) : (
        <ul className="blocked-list">
          {rows.map((r) => (
            <li key={r.id} className="blocked-list__row">
              <Avatar name={r.name} src={r.avatarUrl} seed={r.id} size="sm" />
              <span className="blocked-list__who">
                <strong>{r.name}</strong>
                <span>@{r.handle}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === r.id}
                onClick={async () => {
                  setBusy(r.id);
                  try {
                    await api!.unblock(r.id);
                    setRows((list) => list?.filter((x) => x.id !== r.id) ?? null);
                    toast(`Unblocked @${r.handle}`);
                  } catch {
                    toast("Couldn't unblock. Try again.", "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
