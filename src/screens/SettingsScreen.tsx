import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, LogOut, Monitor, Moon, RotateCcw, ShieldCheck, Sun } from "lucide-react";
import { useIsAdmin } from "../features/admin/useAdmin";
import { profilesEnabled } from "../features/profile/links";
import { dataSource } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { useTheme, type ThemePreference } from "../state/theme";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import "./SettingsScreen.css";

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

/**
 * Account settings: appearance and sign-out. Name editing lives in Edit profile
 * when the backend supports profiles; otherwise (legacy backend) it's here.
 */
export default function SettingsScreen() {
  const viewer = useViewer();
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const [name, setName] = useState(viewer.name);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resetting, setResetting] = useState(false);
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
      <ScreenHeader
        title="Settings"
        leading={
          <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/profile"))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      <div className="profile-head">
        <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="lg" />
        <div>
          <h2 className="profile-head__name">{viewer.name}</h2>
          <p className="profile-head__handle">@{viewer.handle}</p>
        </div>
      </div>

      {!profilesEnabled && (
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
      )}

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

      {isAdmin && (
        <section className="settings-group">
          <Link to="/admin" className="btn btn--secondary btn--md">
            <ShieldCheck size={18} aria-hidden="true" /> Amigo admin
          </Link>
        </section>
      )}

      {dataSource.resetDemo && (
        <section className="settings-group" aria-labelledby="set-demo">
          <h3 id="set-demo" className="settings-group__title">Demo data</h3>
          <p className="settings-meta">
            This preview keeps your changes (profile edits, posts, messages…) in this browser. Resetting brings back the original demo.
          </p>
          <Button
            variant="secondary"
            icon={<RotateCcw size={18} aria-hidden="true" />}
            loading={resetting}
            onClick={async () => {
              if (!window.confirm("Reset all demo data in this browser?")) return;
              setResetting(true);
              await dataSource.resetDemo!().catch(() => undefined);
              window.location.assign("/");
            }}
          >
            Reset demo data
          </Button>
        </section>
      )}

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
