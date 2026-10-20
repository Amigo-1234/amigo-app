import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  ArrowLeft,
  Briefcase,
  Camera,
  Check,
  Clapperboard,
  Compass,
  Cpu,
  FlaskConical,
  Gamepad2,
  GraduationCap,
  Mail,
  Music,
  Orbit,
  Palette,
  PenLine,
  Shirt,
  Sun,
  Trophy,
  UsersRound,
} from "lucide-react";
import { BIO_MAX_LENGTH, dataSource, HANDLE_PATTERN, INTERESTS, NAME_MAX_LENGTH, ProfileError, type Interest, type ProfileUpdate } from "../../data";
import { prepareAvatar, type PreparedImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { useComposer } from "../../state/composer";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Wordmark } from "../../ui/Brand";
import { Button } from "../../ui/Button";
import { limitText } from "../feed/errors";
import { finishOnboarding, INTEREST_LABEL, onboardingSteps, saveOnboarding, type OnboardingProgress, type OnboardingStep } from "./state";
import "./Onboarding.css";

const ICON: Record<Interest, typeof Cpu> = {
  technology: Cpu,
  football: Trophy,
  music: Music,
  gaming: Gamepad2,
  entertainment: Clapperboard,
  fashion: Shirt,
  photography: Camera,
  business: Briefcase,
  education: GraduationCap,
  science: FlaskConical,
  art: Palette,
  lifestyle: Sun,
};
const RESEND_AFTER_MS = 60_000;

/**
 * Joining Amigo, after the account exists: confirm your email (a code),
 * pick what you're into, set up your profile, then a welcome with first
 * things to do. Every step but the first can be skipped; nothing is lost on a
 * refresh (see state.ts). The phone's Back gesture goes back a step.
 */
export function Onboarding({ initial, onDone }: { initial: OnboardingProgress; onDone: () => void }) {
  const viewer = useViewer();
  const steps = onboardingSteps(viewer.emailVerified);
  const [progress, setProgress] = useState<OnboardingProgress>(() => (steps.includes(initial.step) ? initial : { ...initial, step: steps[0] }));
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const index = steps.indexOf(progress.step);

  const update = useCallback(
    (patch: Partial<OnboardingProgress>) =>
      setProgress((p) => {
        const next = { ...p, ...patch };
        saveOnboarding(viewer.id, next);
        return next;
      }),
    [viewer.id],
  );

  // Each step is a history entry, so the phone's Back gesture returns to the previous one.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { onboardingStep?: OnboardingStep } | null)?.onboardingStep;
      if (s && steps.includes(s)) {
        setDir("back");
        update({ step: s });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [steps, update]);
  useEffect(() => {
    if ((history.state as { onboardingStep?: string } | null)?.onboardingStep !== progress.step) {
      history.replaceState({ ...(history.state ?? {}), onboardingStep: progress.step }, "");
    }
  }, [progress.step]);

  const next = () => {
    const to = steps[index + 1];
    if (!to) return;
    setDir("fwd");
    history.pushState({ ...(history.state ?? {}), onboardingStep: to }, "");
    update({ step: to });
  };
  const back = index > 0 && progress.step !== "welcome" ? () => history.back() : null;
  const done = () => {
    finishOnboarding(viewer.id);
    onDone();
  };

  return (
    <div className="onb">
      <header className="onb__top">
        {back ? (
          <button type="button" className="onb__back" onClick={back} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
        ) : (
          <span className="onb__back-space" />
        )}
        <Wordmark />
        <span className="onb__back-space" />
      </header>
      <div className="onb__progress" role="progressbar" aria-label="Joining Amigo" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1}>
        <span style={{ transform: `scaleX(${(index + 1) / steps.length})` }} />
      </div>
      <main className={`onb__step onb__step--${dir}`} key={progress.step}>
        {progress.step === "verify" && <VerifyStep progress={progress} update={update} onNext={next} />}
        {progress.step === "interests" && <InterestsStep progress={progress} update={update} onNext={next} />}
        {progress.step === "profile" && <ProfileStep interests={progress.interests} onNext={next} onEditInterests={back && steps.includes("interests") ? () => history.go(-1) : null} />}
        {progress.step === "welcome" && <WelcomeStep onDone={done} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- verify

function VerifyStep({ progress, update, onNext }: { progress: OnboardingProgress; update: (p: Partial<OnboardingProgress>) => void; onNext: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const api = dataSource.emailVerification!;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await api.sendCode();
      update({ codeSentAt: Date.now() });
    } catch (e) {
      setError(codeError(e, "We couldn't send the code. Check your connection and try again."));
    } finally {
      sending.current = false;
    }
  }, [api, update]);

  // The first code goes out as soon as this step opens (once: a refresh doesn't send another).
  useEffect(() => {
    if (!progress.codeSentAt) void send();
  }, [progress.codeSentAt, send]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Verified meanwhile (another tab, Settings): move on.
  useEffect(() => {
    if (viewer.emailVerified) onNext();
  }, [viewer.emailVerified, onNext]);

  const wait = progress.codeSentAt ? Math.max(0, Math.ceil((progress.codeSentAt + RESEND_AFTER_MS - now) / 1000)) : 0;

  async function verify(e?: FormEvent) {
    e?.preventDefault();
    if (code.length < 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.verify(code);
      toast("Email confirmed");
      onNext();
    } catch (err) {
      setError(codeError(err, "That code didn't work. Check it and try again."));
      setCode("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  // A full code (typed, pasted or filled in by the phone) is checked at once.
  useEffect(() => {
    if (code.length === 6) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <form className="onb__body" onSubmit={verify}>
      <span className="onb__icon" aria-hidden="true">
        <Mail size={26} />
      </span>
      <h1 className="onb__title">Check your email</h1>
      <p className="onb__lead">
        We sent a 6-digit code to <strong>{viewer.email}</strong>. It expires in 15 minutes.
      </p>
      <CodeBoxes inputRef={inputRef} value={code} onChange={setCode} disabled={busy} invalid={!!error} />
      {error && (
        <p className="onb__error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" block loading={busy} disabled={code.length < 6}>
        Confirm email
      </Button>
      <div className="onb__row">
        <Button type="button" variant="ghost" size="sm" disabled={wait > 0} onClick={() => void send()}>
          {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setHelp((h) => !h)} aria-expanded={help}>
          Didn't get it?
        </Button>
      </div>
      {help && (
        <div className="onb__help">
          <ul>
            <li>
              Look in your <strong>Spam</strong> or <strong>Junk</strong> folder — the email comes from Neon Auth (auth@mail.myneon.app).
            </li>
            <li>It can take a minute or two. Then send a new code above.</li>
            <li>
              Is <strong>{viewer.email}</strong> right? If not, sign out and create your account again with the right address.
            </li>
          </ul>
        </div>
      )}
      <button type="button" className="onb__skip" onClick={onNext}>
        Confirm later
      </button>
      <p className="onb__note">Until you confirm, a reminder stays in Settings → Account.</p>
    </form>
  );
}

/** Six boxes over one real input: typing, pasting and the phone's "from Messages/Mail" code all just work. */
function CodeBoxes({ value, onChange, disabled, invalid, inputRef }: { value: string; onChange: (v: string) => void; disabled: boolean; invalid: boolean; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [focused, setFocused] = useState(false);
  return (
    <label className={`onb-code${invalid ? " is-invalid" : ""}${focused ? " is-focused" : ""}`}>
      <span className="visually-hidden">Verification code</span>
      <input
        ref={inputRef}
        className="onb-code__input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        autoFocus
        value={value}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        aria-invalid={invalid}
      />
      <span className="onb-code__boxes" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`onb-code__box${value[i] ? " is-filled" : ""}${focused && i === Math.min(value.length, 5) ? " is-current" : ""}`}>
            {value[i] ?? ""}
          </span>
        ))}
      </span>
    </label>
  );
}

function codeError(e: unknown, fallback: string): string {
  const err = e as { code?: string; message?: string } | null;
  const s = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
  if (/expired/.test(s)) return "That code has expired. Send a new one and use it within 15 minutes.";
  if (/too.?many|rate|429/.test(s)) return "Too many tries. Wait a minute, then send a new code.";
  if (/invalid|incorrect|otp/.test(s)) return "That code isn't right. Check the latest email and try again.";
  if (/network|fetch|load failed/.test(s)) return "You seem to be offline. Check your connection and try again.";
  return fallback;
}

// ------------------------------------------------------------- interests

function InterestsStep({ progress, update, onNext }: { progress: OnboardingProgress; update: (p: Partial<OnboardingProgress>) => void; onNext: () => void }) {
  const api = dataSource.interests!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = new Set(progress.interests);
  const toggle = (i: Interest) => update({ interests: picked.has(i) ? progress.interests.filter((x) => x !== i) : [...progress.interests, i] });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.set(progress.interests);
      onNext();
    } catch {
      setError("We couldn't save your interests. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onb__body">
      <h1 className="onb__title">What are you into?</h1>
      <p className="onb__lead">Pick as many as you like. We'll use them to help you find people and posts — you can change them any time in Settings.</p>
      <div className="onb-interests" role="group" aria-label="Interests">
        {INTERESTS.map((i, n) => {
          const Icon = ICON[i];
          const on = picked.has(i);
          return (
            <button key={i} type="button" className={`onb-interest${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => toggle(i)} style={{ animationDelay: `${n * 25}ms` }}>
              <span className="onb-interest__icon" aria-hidden="true">
                {on ? <Check size={18} strokeWidth={3} /> : <Icon size={18} />}
              </span>
              {INTEREST_LABEL[i]}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="onb__error" role="alert">
          {error}
        </p>
      )}
      <div className="onb__footer">
        <Button size="lg" block loading={busy} onClick={() => void save()}>
          {picked.size ? `Continue with ${picked.size}` : "Continue"}
        </Button>
        {!picked.size && (
          <button type="button" className="onb__skip" onClick={onNext}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- profile

type HandleState = "unchanged" | "invalid" | "checking" | "available" | "taken";

function ProfileStep({ interests, onNext, onEditInterests }: { interests: Interest[]; onNext: () => void; onEditInterests: (() => void) | null }) {
  const viewer = useViewer();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(viewer.name);
  const [handle, setHandle] = useState(viewer.handle);
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState<PreparedImage | undefined>(undefined);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [handleState, setHandleState] = useState<HandleState>("unchanged");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanHandle = handle.trim().toLowerCase().replace(/^@/, "");
  const handleChanged = cleanHandle !== viewer.handle;
  useEffect(() => {
    if (!handleChanged) return setHandleState("unchanged");
    if (!HANDLE_PATTERN.test(cleanHandle)) return setHandleState("invalid");
    setHandleState("checking");
    let cancelled = false;
    const t = setTimeout(() => {
      dataSource.profiles
        ?.isHandleAvailable(cleanHandle, viewer.id)
        .then((ok) => !cancelled && setHandleState(ok ? "available" : "taken"))
        .catch(() => !cancelled && setHandleState("available")); // saving is the final check
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cleanHandle, handleChanged, viewer.id]);

  const nameOk = name.trim().length > 0 && name.trim().length <= NAME_MAX_LENGTH;
  const handleOk = handleState === "unchanged" || handleState === "available";
  const left = BIO_MAX_LENGTH - bio.length;

  async function pick(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setError(null);
    try {
      setAvatar(await prepareAvatar(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || !handleOk || left < 0 || saving || avatarBusy) return;
    const update: ProfileUpdate = {};
    if (name.trim() !== viewer.name) update.name = name.trim();
    if (handleChanged) update.handle = cleanHandle;
    if (bio.trim()) update.bio = bio.trim();
    if (avatar) update.avatar = avatar;
    if (!Object.keys(update).length || !dataSource.profiles) return onNext();
    setSaving(true);
    setError(null);
    try {
      await dataSource.profiles.updateProfile(viewer.id, update);
      toast("Profile saved");
      onNext();
    } catch (err) {
      if (err instanceof ProfileError && err.code === "handle-taken") setHandleState("taken");
      else if (err instanceof ProfileError && err.code === "handle-invalid") setHandleState("invalid");
      else setError(limitText(err) ?? "We couldn't save your profile. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const handleHint: Record<HandleState, string> = {
    unchanged: "This is how people find and mention you.",
    invalid: "3–24 characters: lowercase letters, numbers and _ only.",
    checking: "Checking…",
    available: "Available",
    taken: "That username is taken — try another.",
  };

  return (
    <form className="onb__body" onSubmit={save}>
      <h1 className="onb__title">Make it yours</h1>
      <p className="onb__lead">A photo and a few words help your people recognise you.</p>
      <button type="button" className={`onb-avatar${avatar ? " has-photo" : ""}`} onClick={() => fileRef.current?.click()} aria-label={avatar || viewer.avatarUrl ? "Change profile photo" : "Add a profile photo"}>
        <span className="onb-avatar__img" key={avatar?.dataUrl ?? "current"}>
          <Avatar name={name || viewer.name} src={avatar?.dataUrl ?? viewer.avatarUrl} seed={viewer.id} size="xl" />
        </span>
        <span className="onb-avatar__badge" aria-hidden="true">
          {avatarBusy ? <span className="btn__spinner" /> : <Camera size={16} />}
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />

      <label className="field">
        <span className="field__label">Name</span>
        <input className="field__input" value={name} maxLength={NAME_MAX_LENGTH} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={!nameOk} />
      </label>
      <label className="field">
        <span className="field__label">Username</span>
        <span className="onb-handle">
          <span aria-hidden="true">@</span>
          <input
            className="field__input"
            value={handle}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            onChange={(e) => setHandle(e.target.value)}
            aria-invalid={handleState === "invalid" || handleState === "taken"}
            aria-describedby="onb-handle-hint"
          />
        </span>
        <span id="onb-handle-hint" className={`onb-hint onb-hint--${handleState}`} aria-live="polite">
          {handleHint[handleState]}
        </span>
      </label>
      <label className="field">
        <span className="field__label">
          Bio <span className={`field__count${left < 20 ? " is-low" : ""}`}>{left} left</span>
        </span>
        <textarea className="field__input" rows={3} value={bio} placeholder="Say a little about yourself" onChange={(e) => setBio(e.target.value)} aria-invalid={left < 0} />
      </label>
      {interests.length > 0 && (
        <div className="onb-picked">
          <span className="field__label">Your interests</span>
          <div className="onb-picked__list">
            {interests.map((i) => (
              <span key={i} className="onb-chip">
                {INTEREST_LABEL[i]}
              </span>
            ))}
            {onEditInterests && (
              <button type="button" className="onb-chip onb-chip--edit" onClick={onEditInterests}>
                Edit
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="onb__error" role="alert">
          {error}
        </p>
      )}
      <div className="onb__footer">
        <Button type="submit" size="lg" block loading={saving} disabled={!nameOk || !handleOk || left < 0 || avatarBusy}>
          Continue
        </Button>
        <button type="button" className="onb__skip" onClick={onNext}>
          Skip for now
        </button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------- welcome

function WelcomeStep({ onDone }: { onDone: () => void }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const composer = useComposer();
  const go = (to: string, compose = false) => {
    onDone();
    navigate(to);
    if (compose) setTimeout(() => composer.setOpen(true), 50);
  };
  const actions = [
    { icon: Compass, title: "Explore the feed", body: "See what people are posting right now.", run: () => go("/") },
    ...(dataSource.discovery ? [{ icon: UsersRound, title: "Find people", body: "Search and follow people you know.", run: () => go("/explore") }] : []),
    { icon: PenLine, title: "Say hello", body: "Share your first post.", run: () => go("/", true) },
    ...(dataSource.worlds ? [{ icon: Orbit, title: "Discover Worlds", body: "Join live spaces around a topic or event.", run: () => go("/worlds") }] : []),
  ];
  return (
    <div className="onb__body onb-welcome">
      <span className="onb-welcome__badge" aria-hidden="true">
        <Check size={34} strokeWidth={3} />
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="onb-welcome__spark" style={{ "--i": i } as React.CSSProperties} />
        ))}
      </span>
      <h1 className="onb__title">Welcome to Amigo World, {viewer.name.split(" ")[0]}!</h1>
      <p className="onb__lead">You're all set. Here are a few good places to start.</p>
      <ul className="onb-actions">
        {actions.map((a, n) => (
          <li key={a.title} style={{ animationDelay: `${120 + n * 70}ms` }}>
            <button type="button" className="onb-action" onClick={a.run}>
              <span className="onb-action__icon" aria-hidden="true">
                <a.icon size={20} />
              </span>
              <span>
                <strong>{a.title}</strong>
                <span>{a.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button size="lg" block onClick={() => go("/")}>
        Start exploring
      </Button>
    </div>
  );
}
