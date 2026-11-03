import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Briefcase, Camera, Check, Clapperboard, Cpu, FlaskConical, Gamepad2, GraduationCap, Music, Palette, Shirt, Sun, Trophy } from "lucide-react";
import { dataSource, INTERESTS, type Interest } from "../data";
import { INTEREST_LABEL } from "../features/onboarding/state";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";
import "../features/onboarding/Onboarding.css";

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

/**
 * Settings → Interests: the topics picked while joining, editable here. Same
 * storage as onboarding (user_interests, own row only). Kept for suggestions
 * later — nothing ranks or filters by them yet, and the page says so.
 */
export default function InterestsScreen() {
  const api = dataSource.interests;
  const navigate = useNavigate();
  const toast = useToast();
  const [saved, setSaved] = useState<Interest[] | null | "error">(null);
  const [picked, setPicked] = useState<Interest[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setSaved(null);
    api.get().then(
      (list) => {
        if (cancelled) return;
        setSaved(list);
        setPicked(list);
      },
      () => !cancelled && setSaved("error"),
    );
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"));
  const header = (
    <ScreenHeader
      title="Interests"
      leading={
        <IconButton label="Back" onClick={back} className="back-btn">
          <ArrowLeft size={22} />
        </IconButton>
      }
    />
  );
  if (!api) return header;

  const dirty = Array.isArray(saved) && (picked.length !== saved.length || picked.some((i) => !saved.includes(i)));
  const toggle = (i: Interest) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));

  async function save() {
    setBusy(true);
    try {
      const list = await api!.set(picked);
      setSaved(list);
      setPicked(list);
      toast("Interests saved");
    } catch {
      toast("Couldn't save your interests. Check your connection and try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {header}
      <div className="settings">
        <p className="settings-panel__text interests-intro">
          Pick what you're into. We'll use this to suggest people and posts later — your feed isn't filtered by it.
        </p>
        {saved === "error" ? (
          <StateMessage
            tone="error"
            title="Couldn't load your interests"
            body="Check your connection and try again."
            action={
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : saved === null ? (
          <div className="onb-interests" aria-busy="true">
            {INTERESTS.map((i) => (
              <Skeleton key={i} height={52} />
            ))}
          </div>
        ) : (
          <>
            <div className="onb-interests" role="group" aria-label="Interests">
              {INTERESTS.map((i, n) => {
                const Icon = ICON[i];
                const on = picked.includes(i);
                return (
                  <button key={i} type="button" className={`onb-interest${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => toggle(i)} style={{ animationDelay: `${n * 20}ms` }}>
                    <span className="onb-interest__icon" aria-hidden="true">
                      {on ? <Check size={18} strokeWidth={3} /> : <Icon size={18} />}
                    </span>
                    {INTEREST_LABEL[i]}
                  </button>
                );
              })}
            </div>
            <div className="interests-actions">
              <span className="settings-panel__text" aria-live="polite">
                {picked.length ? `${picked.length} selected` : "None selected"}
              </span>
              <Button loading={busy} disabled={!dirty || busy} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
