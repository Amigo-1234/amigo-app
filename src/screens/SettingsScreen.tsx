import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  Ban,
  Download,
  Bookmark,
  ArrowLeft,
  Bell,
  BellOff,
  BellRing,
  Smartphone,
  ChevronRight,
  Eye,
  FileText,
  Info,
  Sparkles,
  KeyRound,
  LogOut,
  Mail,
  Monitor,
  MonitorSmartphone,
  Moon,
  RotateCcw,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  Users,
  Heart,
  Orbit,
  Code2,
} from "lucide-react";
import { CREATOR } from "../lib/creator";
import { useIsAdmin } from "../features/admin/useAdmin";
import { CodeField, PasswordField, authMessage } from "../features/auth";
import { profilesEnabled } from "../features/profile/links";
import { AuthError, dataSource } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { notificationsEnabled, useUnread } from "../state/notifications";
import { securityApi, useSecurity } from "../state/security";
import { useViewer } from "../state/session";
import { useTheme, type ThemePreference } from "../state/theme";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { LoadingScreen } from "../ui/Loader";
import { canPromptInstall, isIOS, isStandalone, promptInstall } from "../lib/install";
import { disablePush, enablePush, pushStatus, type PushStatus } from "../lib/push";
import { timeAgoLong } from "../lib/time";
import type { NotificationPrefs, PushDevice } from "../data";
import "./SettingsScreen.css";

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

const MIN_PASSWORD = 8;
const errorText = (err: unknown) => authMessage(err instanceof AuthError ? err.code : undefined);

const BACKEND_LABEL: Record<string, string> = {
  neon: "Neon",
  supabase: "Supabase",
  firebase: "Classic",
  demo: "Demo data",
};

/**
 * Account settings, grouped: Account, Privacy, Security, Notifications,
 * Appearance, About. Every row is backed by a real capability of the current
 * backend; sections hide what the backend can't do.
 */
export default function SettingsScreen() {
  const viewer = useViewer();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const toast = useToast();

  if (signingOut) return <LoadingScreen label="Signing out" message="Signing out…" />;

  async function signOut() {
    setSigningOut(true);
    try {
      await dataSource.signOut();
    } catch {
      setSigningOut(false);
      toast("Couldn't sign out", "error");
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

      <div className="settings">
        <div className="settings-hero">
          <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="lg" />
          <div className="settings-hero__text">
            <h2 className="settings-hero__name">{viewer.name}</h2>
            <p className="settings-hero__handle">@{viewer.handle}</p>
          </div>
          {profilesEnabled && (
            <Link to={`/u/${viewer.handle}`} className="btn btn--secondary btn--sm">
              View profile
            </Link>
          )}
        </div>

        <AccountSection isAdmin={!!isAdmin} />
        <PrivacySection />
        <SecuritySection onSignOut={signOut} />
        {notificationsEnabled && <NotificationsSection />}
        <AppearanceSection />
        <AboutSection />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ layout

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id} className="settings-section__title">{title}</h3>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function Row({ icon, title, detail, trailing }: { icon: ReactNode; title: ReactNode; detail?: ReactNode; trailing?: ReactNode }) {
  return (
    <>
      <span className="settings-row__icon" aria-hidden="true">{icon}</span>
      <span className="settings-row__text">
        <span className="settings-row__title">{title}</span>
        {detail && <span className="settings-row__detail">{detail}</span>}
      </span>
      {trailing}
    </>
  );
}

function LinkRow({ to, ...row }: { to: string } & Parameters<typeof Row>[0]) {
  return (
    <Link to={to} className="settings-row settings-row--action">
      <Row {...row} trailing={row.trailing ?? <ChevronRight size={18} className="settings-row__chev" aria-hidden="true" />} />
    </Link>
  );
}

function ButtonRow({ onClick, expanded, danger, ...row }: { onClick: () => void; expanded?: boolean; danger?: boolean } & Parameters<typeof Row>[0]) {
  return (
    <button type="button" className={`settings-row settings-row--action${danger ? " settings-row--danger" : ""}`} onClick={onClick} aria-expanded={expanded}>
      <Row {...row} trailing={row.trailing ?? (expanded === undefined ? null : <ChevronRight size={18} className={`settings-row__chev${expanded ? " is-open" : ""}`} aria-hidden="true" />)} />
    </button>
  );
}

function InfoRow(row: Parameters<typeof Row>[0]) {
  return (
    <div className="settings-row">
      <Row {...row} />
    </div>
  );
}

// ----------------------------------------------------------------- Account

function AccountSection({ isAdmin }: { isAdmin: boolean }) {
  const viewer = useViewer();
  const [verifying, setVerifying] = useState(false);
  const canVerify = !!dataSource.emailVerification && viewer.emailVerified === false;

  return (
    <Section id="set-account" title="Account">
      {viewer.email && (
        <>
          {canVerify ? (
            <ButtonRow
              icon={<Mail size={20} />}
              title={viewer.email}
              detail={<span className="settings-badge settings-badge--warn">Not verified · Verify now</span>}
              onClick={() => setVerifying((v) => !v)}
              expanded={verifying}
            />
          ) : (
            <InfoRow
              icon={<Mail size={20} />}
              title={viewer.email}
              detail={viewer.emailVerified ? <span className="settings-badge settings-badge--ok">Verified</span> : "Your sign-in email"}
            />
          )}
          {canVerify && verifying && <VerifyEmailPanel email={viewer.email} />}
        </>
      )}
      {profilesEnabled ? (
        <LinkRow to={`/u/${viewer.handle}`} icon={<UserRound size={20} />} title="Profile" detail="Name, username, bio and photo — edit from your profile" />
      ) : (
        <DisplayNameRow />
      )}
      {dataSource.postTools && <LinkRow to="/bookmarks" icon={<Bookmark size={20} />} title="Bookmarks" detail="Posts you saved. Only you can see them" />}
      {dataSource.monetization && (
        <LinkRow to="/settings/monetization" icon={<Sparkles size={20} />} title="Creator monetization" detail="Coming soon — see your standing and engagement" />
      )}
      {isAdmin && <LinkRow to="/admin" icon={<ShieldCheck size={20} />} title="Amigo admin" detail="Moderation, verification and support tools" />}
      {dataSource.deleteAccount && <DeleteAccountRow />}
    </Section>
  );
}

/** Legacy backends without profiles: the display name is edited here. */
function DisplayNameRow() {
  const viewer = useViewer();
  const toast = useToast();
  const [name, setName] = useState(viewer.name);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() && name.trim() !== viewer.name;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
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
    <form className="settings-panel" onSubmit={save}>
      <label className="auth-field__label" htmlFor="display-name">Display name</label>
      <div className="settings-inline">
        <input id="display-name" className="auth-field__input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={!dirty} loading={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Confirms email ownership with an emailed code (Neon). */
function VerifyEmailPanel({ email }: { email: string }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const send = () =>
    run(async () => {
      await dataSource.emailVerification!.sendCode();
      setSent(true);
    });

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await dataSource.emailVerification!.verify(code);
      // The session updates in place: badge, admin access and verification follow without a reload.
      toast("Email verified");
    });
  };

  return (
    <div className="settings-panel">
      <p className="settings-panel__text">
        {sent ? (
          <>
            Enter the code we sent to <strong>{email}</strong>. It expires in 15 minutes.
          </>
        ) : (
          "We'll email you a short code to confirm this address is yours."
        )}
      </p>
      {error && <p className="auth__error" role="alert">{error}</p>}
      {sent ? (
        <form className="settings-panel__form" onSubmit={verify}>
          <CodeField label="Verification code" value={code} onChange={setCode} autoFocus />
          <div className="settings-panel__actions">
            <Button type="submit" loading={busy} disabled={busy || code.length < 4}>
              Verify email
            </Button>
            <Button type="button" variant="ghost" onClick={send} disabled={busy}>
              Send a new code
            </Button>
          </div>
        </form>
      ) : (
        <div className="settings-panel__actions">
          <Button onClick={send} loading={busy} disabled={busy}>
            Send code
          </Button>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Privacy

/** How visibility works today — explanations, not toggles (there are no account-wide privacy switches yet). */
function PrivacySection() {
  return (
    <Section id="set-privacy" title="Privacy">
      <InfoRow icon={<Eye size={20} />} title="Profile" detail="Your profile, followers and public posts are visible to people on Amigo." />
      <InfoRow icon={<Users size={20} />} title="Who sees what you share" detail="Posts are public. For a Moment, you choose Everyone or Followers each time." />
      {dataSource.messages && <InfoRow icon={<KeyRound size={20} />} title="Messages" detail="End-to-end encrypted. Only your devices can read them." />}
      {dataSource.blocking && <LinkRow to="/settings/blocked" icon={<Ban size={20} />} title="Blocked accounts" detail="People you blocked can't message you, follow you, or see or reply to your posts. They aren't told" />}
    </Section>
  );
}

// ---------------------------------------------------------------- Security

function SecuritySection({ onSignOut }: { onSignOut: () => void }) {
  const { devices, newDevices } = useSecurity();
  const [changing, setChanging] = useState(false);

  return (
    <Section id="set-security" title="Security">
      <ButtonRow
        icon={<KeyRound size={20} />}
        title="Password"
        detail={dataSource.passwordResetByCode ? "Change it with a code sent to your email" : "Get a link to set a new password"}
        onClick={() => setChanging((c) => !c)}
        expanded={changing}
      />
      {changing && <ChangePasswordPanel onDone={() => setChanging(false)} />}
      {securityApi && (
        <>
          <LinkRow
            to="/settings/devices"
            icon={<MonitorSmartphone size={20} />}
            title="Your devices"
            detail={`${devices ? `${devices.length} device${devices.length === 1 ? "" : "s"}` : "Devices that can read your messages"}${newDevices.length ? ` · ${newDevices.length} new` : ""}`}
          />
          <LinkRow to="/settings/backup" icon={<KeyRound size={20} />} title="Message backup" detail="Restore your message history with a recovery key" />
        </>
      )}
      <ButtonRow icon={<LogOut size={20} />} title="Sign out" detail="Sign out on this device" onClick={onSignOut} danger />
    </Section>
  );
}

function ChangePasswordPanel({ onDone }: { onDone: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const byCode = dataSource.passwordResetByCode;
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const email = viewer.email;

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!email) return <div className="settings-panel"><p className="settings-panel__text">This account has no email to send a code to.</p></div>;

  const send = () =>
    run(async () => {
      if (byCode) await byCode.send(email);
      else await dataSource.sendPasswordReset(email);
      setSent(true);
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await byCode!.reset(email, code, password);
      toast("Password changed");
      onDone();
    });
  };

  if (!byCode) {
    return (
      <div className="settings-panel">
        <p className="settings-panel__text">
          {sent ? <>We sent a link to <strong>{email}</strong>. Open it to choose a new password.</> : <>We'll email a link to <strong>{email}</strong> to set a new password.</>}
        </p>
        {error && <p className="auth__error" role="alert">{error}</p>}
        {!sent && (
          <div className="settings-panel__actions">
            <Button onClick={send} loading={busy} disabled={busy}>
              Email me a link
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <p className="settings-panel__text">
        {sent ? <>Enter the code we sent to <strong>{email}</strong> and your new password.</> : <>We'll email a code to <strong>{email}</strong> to confirm it's you.</>}
      </p>
      {error && <p className="auth__error" role="alert">{error}</p>}
      {sent ? (
        <form className="settings-panel__form" onSubmit={save}>
          <CodeField label="Code from your email" value={code} onChange={setCode} autoFocus />
          <PasswordField label="New password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="settings-panel__actions">
            <Button type="submit" loading={busy} disabled={busy || code.length < 4 || password.length < MIN_PASSWORD}>
              Change password
            </Button>
            <Button type="button" variant="ghost" onClick={send} disabled={busy}>
              Send a new code
            </Button>
          </div>
        </form>
      ) : (
        <div className="settings-panel__actions">
          <Button onClick={send} loading={busy} disabled={busy}>
            Send code
          </Button>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- Notifications

function NotificationsSection() {
  const { unread, markAllRead } = useUnread();
  const toast = useToast();
  const [marking, setMarking] = useState(false);

  return (
    <Section id="set-notifications" title="Notifications">
      <LinkRow
        to="/notifications"
        icon={<Bell size={20} />}
        title="Activity"
        detail={unread ? `${unread} unread` : "Follows, likes, replies and mentions"}
      />
      <ButtonRow
        icon={<BellOff size={20} />}
        title="Mark all as read"
        detail={unread ? "Clear your unread badge" : "You're all caught up"}
        onClick={async () => {
          if (!unread || marking) return;
          setMarking(true);
          await markAllRead().catch(() => toast("Couldn't update notifications", "error"));
          setMarking(false);
        }}
        trailing={marking ? <span className="btn__spinner settings-row__spin" aria-hidden="true" /> : null}
      />
      {dataSource.push && <PushSettings />}
    </Section>
  );
}

const PUSH_DETAIL: Record<PushStatus, string> = {
  on: "On. You'll be told about new messages even when Amigo is closed or your phone is locked.",
  off: "Get told about new messages even when Amigo is closed or your phone is locked.",
  "ios-home-screen": "On iPhone and iPad, notifications work once Amigo is on your Home Screen: in Safari tap Share → Add to Home Screen, open Amigo from there, then turn them on here.",
  denied: "Notifications are blocked for Amigo. Allow them in your browser's site settings (or your phone's Settings → Notifications), then come back here.",
  unsupported: "This browser can't show notifications from websites. Try Chrome, Edge, Firefox or Safari.",
  "not-configured": "Notifications aren't available on this version of Amigo yet.",
};

/** Locked-screen notifications for this device, what to be notified about, and your other devices. */
function PushSettings() {
  const api = dataSource.push!;
  const viewer = useViewer();
  const toast = useToast();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);

  useEffect(() => {
    let live = true;
    pushStatus(api).then((s) => live && setStatus(s), () => live && setStatus("unsupported"));
    api.prefs(viewer.id).then((p) => live && setPrefs(p), () => undefined);
    return () => {
      live = false;
    };
  }, [api, viewer.id]);
  const loadDevices = () => api.devices(viewer.id).then(setDevices, () => setDevices([]));
  useEffect(() => void loadDevices(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle() {
    if (busy || !status) return;
    setBusy(true);
    try {
      if (status === "on") {
        await disablePush(api);
        setStatus("off");
        toast("Notifications turned off on this device");
      } else {
        const next = await enablePush(api);
        setStatus(next);
        if (next === "on") toast("Notifications are on for this device");
        else if (next === "denied") toast("Notifications are blocked — allow them in your settings", "error");
      }
    } catch (e) {
      // The reason only (e.g. "Registration failed - push service error"); no keys or endpoints.
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("push:", reason);
      // Chrome refuses push in private/incognito windows with this error, after permission was granted.
      toast(
        /Registration failed - permission denied/i.test(reason)
          ? "This window can't receive notifications. Private or incognito windows don't support them — try a normal window."
          : "Couldn't change notifications. Try again.",
        "error",
      );
      setStatus(await pushStatus(api).catch(() => "unsupported" as const));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const r = await api.sendTest();
    if (r === "sent") toast("Test sent — it should arrive in a few seconds");
    else if (r === "wait") toast("Wait a few seconds before sending another test");
    else toast("Couldn't send a test. Try again.", "error");
  }

  async function setPref(key: keyof NotificationPrefs, value: boolean) {
    setPrefs((p) => (p ? { ...p, [key]: value } : p));
    await api.setPrefs({ [key]: value }).catch(() => {
      setPrefs((p) => (p ? { ...p, [key]: !value } : p));
      toast("Couldn't save that. Try again.", "error");
    });
  }

  const canToggle = status === "on" || status === "off";
  return (
    <>
      <ButtonRow
        icon={<BellRing size={20} />}
        title="Notifications on this device"
        detail={status ? PUSH_DETAIL[status] : "Checking…"}
        onClick={canToggle ? toggle : () => undefined}
        trailing={
          busy ? (
            <span className="btn__spinner settings-row__spin" aria-hidden="true" />
          ) : canToggle ? (
            <span className={`settings-switch${status === "on" ? " is-on" : ""}`} role="switch" aria-checked={status === "on"} aria-label="Notifications on this device" />
          ) : null
        }
      />
      {status === "on" && (
        <div className="settings-panel">
          <div className="settings-panel__actions">
            <Button size="sm" variant="secondary" onClick={sendTest}>
              Send a test notification
            </Button>
          </div>
        </div>
      )}
      {prefs && (
        <label className="settings-row">
          <Row
            icon={<Mail size={20} />}
            title="New messages"
            detail="Notifications never include the message itself — only that you have a new one."
            trailing={<input type="checkbox" className="settings-check" checked={prefs.messages} onChange={(e) => setPref("messages", e.target.checked)} />}
          />
        </label>
      )}
      {prefs && (
        <label className="settings-row">
          <Row
            icon={<Heart size={20} />}
            title="Likes, replies and follows"
            detail="Also mentions and support on your Support Hub requests. Grouped when lots happen at once."
            trailing={<input type="checkbox" className="settings-check" checked={prefs.social} onChange={(e) => setPref("social", e.target.checked)} />}
          />
        </label>
      )}
      {prefs && dataSource.worlds && (
        <label className="settings-row">
          <Row
            icon={<Orbit size={20} />}
            title="Worlds"
            detail="When a World you joined goes live, or is cancelled."
            trailing={<input type="checkbox" className="settings-check" checked={prefs.worlds} onChange={(e) => setPref("worlds", e.target.checked)} />}
          />
        </label>
      )}
      {devices && devices.length > 0 && (
        <div className="settings-panel">
          <p className="settings-panel__text">Devices that get your notifications</p>
          <ul className="settings-devices">
            {devices.map((d) => (
              <li key={d.id}>
                <Smartphone size={18} aria-hidden="true" />
                <span>
                  <span className="settings-devices__name">{d.label || "Device"}</span>
                  <span className="settings-devices__when">Active {timeAgoLong(d.lastSeenAt)}</span>
                </span>
                <IconButton
                  label={`Stop notifications on ${d.label || "this device"}`}
                  onClick={async () => {
                    await api.removeDevice(d.id).catch(() => toast("Couldn't remove it. Try again.", "error"));
                    await loadDevices();
                    setStatus(await pushStatus(api));
                  }}
                >
                  <Trash2 size={18} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------- Appearance

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  return (
    <Section id="set-appearance" title="Appearance">
      <div className="settings-panel">
        <div className="segmented" role="radiogroup" aria-labelledby="set-appearance">
          {THEMES.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={preference === id} className="segmented__opt" onClick={() => setPreference(id)}>
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------- About

function AboutSection() {
  const [resetting, setResetting] = useState(false);
  return (
    <Section id="set-about" title="About">
      <InfoRow icon={<Info size={20} />} title="Amigo World" detail={`Version ${__APP_VERSION__} · ${BACKEND_LABEL[dataSource.kind] ?? dataSource.kind}`} />
      <a href={CREATOR.url} target="_blank" rel="noopener noreferrer" className="settings-row settings-row--action">
        <Row
          icon={<Code2 size={20} />}
          title={`Built by ${CREATOR.name} · ${CREATOR.studio}`}
          detail={`Amigo World is created by ${CREATOR.studio}. See more work at ${CREATOR.url.replace("https://", "")}`}
          trailing={<ChevronRight size={18} className="settings-row__chev" aria-hidden="true" />}
        />
      </a>
      <LinkRow to="/legal" icon={<FileText size={20} />} title="Terms, privacy and policies" detail="Terms of Service, Privacy Policy, Community Guidelines and more" />
      <InstallRow />
      {dataSource.resetDemo && (
        <ButtonRow
          icon={<RotateCcw size={20} />}
          title="Reset demo data"
          detail="This preview keeps your changes in this browser. Reset brings back the original demo."
          trailing={resetting ? <span className="btn__spinner settings-row__spin" aria-hidden="true" /> : null}
          onClick={async () => {
            if (resetting || !window.confirm("Reset all demo data in this browser?")) return;
            setResetting(true);
            await dataSource.resetDemo!().catch(() => undefined);
            window.location.assign("/");
          }}
        />
      )}
    </Section>
  );
}

/** Install as an app: the browser's prompt where there is one, Add to Home Screen steps on iPhone. Hidden once installed. */
function InstallRow() {
  const [, rerender] = useState(0);
  const [showSteps, setShowSteps] = useState(false);
  if (isStandalone()) return null;
  if (canPromptInstall()) {
    return (
      <ButtonRow
        icon={<Download size={20} />}
        title="Install Amigo"
        detail="Add Amigo to your home screen and open it like an app"
        onClick={async () => {
          await promptInstall();
          rerender((n) => n + 1);
        }}
      />
    );
  }
  if (!isIOS()) return null;
  return (
    <>
      <ButtonRow icon={<Download size={20} />} title="Install Amigo on iPhone" detail="Add it to your Home Screen from Safari" onClick={() => setShowSteps((v) => !v)} expanded={showSteps} />
      {showSteps && (
        <ol className="settings-steps">
          <li>Open Amigo World in Safari.</li>
          <li>Tap the Share button (the square with an arrow).</li>
          <li>Choose “Add to Home Screen”, then “Add”.</li>
        </ol>
      )}
    </>
  );
}

/** Permanent deletion: explains what goes, re-checks the password, then deletes on the server. */
function DeleteAccountRow() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || confirmText !== "DELETE" || !password) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await dataSource.deleteAccount!(password);
    } catch (err) {
      setError(err instanceof AuthError && err.code === "invalid-credentials" ? "That password isn't right." : "Couldn't delete your account. Try again.");
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <ButtonRow icon={<Trash2 size={20} />} title="Delete account" detail="Permanently delete your account and data" onClick={() => setOpen((o) => !o)} expanded={open} danger />
      {open && (
        <form className="settings-panel" onSubmit={remove}>
          <p className="settings-panel__text">
            This permanently deletes your profile, posts (and the replies under them), likes, follows, Moments, World and Support Hub activity, messaging
            devices, keys, backups and the conversations you're in. It can't be undone. See the <Link to="/legal/deletion">Account Deletion Policy</Link>.
          </p>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <PasswordField label="Your password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="auth-field">
            <label className="auth-field__label" htmlFor="delete-confirm">Type DELETE to confirm</label>
            <input id="delete-confirm" className="auth-field__input" value={confirmText} autoCapitalize="characters" onChange={(e) => setConfirmText(e.target.value)} />
          </div>
          <div className="settings-panel__actions">
            <Button type="submit" variant="danger" loading={busy} disabled={busy || !password || confirmText !== "DELETE"}>
              Delete my account
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

