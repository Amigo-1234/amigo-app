import { useState, type FormEvent } from "react";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { dataSource } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { useTheme, type ThemePreference } from "../state/theme";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import "./ProfileScreen.css";

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

/**
 * Phase 1: account essentials only (identity, name, theme, sign out).
 * Full public profiles — header, stats, post grid, follow lists — are Phase 2.
 */
export default function ProfileScreen() {
  const viewer = useViewer();
  const toast = useToast();
  const { preference, setPreference } = useTheme();
  const [name, setName] = useState(viewer.name);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const dirty = name.trim() && name.trim() !== viewer.name;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    try {
      await dataSource.updateDisplayName(name);
      toast("Name updated");
    } catch {
      toast("Couldn't update your name", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ScreenHeader title="Profile" />
      <div className="profile-head">
        <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="xl" />
        <div>
          <h2 className="profile-head__name">{viewer.name}</h2>
          <p className="profile-head__handle">@{viewer.handle}</p>
        </div>
      </div>

      <p className="profile-note">Full profiles — your posts, followers and media — are coming in the next update.</p>

      <section className="settings-group" aria-labelledby="set-name">
        <h3 id="set-name" className="settings-group__title">Display name</h3>
        <form className="settings-row" onSubmit={saveName}>
          <label className="visually-hidden" htmlFor="display-name">
            Display name
          </label>
          <input id="display-name" className="field__input settings-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={!dirty} loading={saving}>
            Save
          </Button>
        </form>
      </section>

      <section className="settings-group" aria-labelledby="set-theme">
        <h3 id="set-theme" className="settings-group__title">Appearance</h3>
        <div className="segmented" role="radiogroup" aria-labelledby="set-theme">
          {THEMES.map(({ id, label, icon: Icon }) => (
            <button key={id} role="radio" aria-checked={preference === id} className="segmented__opt" onClick={() => setPreference(id)}>
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        {viewer.email && <p className="settings-meta">Signed in as {viewer.email}</p>}
        <Button
          variant="danger"
          icon={<LogOut size={18} aria-hidden="true" />}
          loading={signingOut}
          onClick={async () => {
            setSigningOut(true);
            await dataSource.signOut().catch(() => toast("Couldn't sign out", "error"));
            setSigningOut(false);
          }}
        >
          Sign out
        </Button>
      </section>
    </>
  );
}
