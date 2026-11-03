/**
 * In-app alert preferences, per device (they're about this screen and speaker,
 * not the account). Stored in localStorage when available; defaults otherwise.
 */
export interface AlertPrefs {
  banners: boolean;
  sounds: boolean;
}

const KEY = "amigo:alerts";
const DEFAULTS: AlertPrefs = { banners: true, sounds: true };

export function alertPrefs(): AlertPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AlertPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function setAlertPrefs(next: Partial<AlertPrefs>): AlertPrefs {
  const merged = { ...alertPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Private mode or storage blocked: the choice lasts for this visit only.
  }
  return merged;
}

// ------------------------------------------------------------------ sound

/**
 * Amigo's alert sounds, synthesised on the device (no audio files, nothing
 * licensed): a soft two-note rise for messages, a single gentle note for other
 * activity. Browsers only allow sound after the person has interacted with the
 * page, so the audio context is created on the first tap and sounds before that
 * are skipped silently. Nothing here plays while the app is closed: a push
 * notification uses the device's own sound.
 */
let ctx: AudioContext | null = null;
let unlocked = false;

function unlock() {
  if (unlocked) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    void ctx.resume();
    unlocked = true;
  } catch {
    // No Web Audio: alerts stay silent.
  }
}
if (typeof window !== "undefined") {
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { once: false, passive: true, capture: true });
}

function note(at: number, freq: number, dur: number, peak: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

let lastPlayed = 0;

/** Plays the alert if allowed; at most one sound every 1.5 s so bursts don't chatter. */
export function playAlertSound(kind: "message" | "social") {
  if (!unlocked || !ctx || ctx.state !== "running") return false;
  const now = Date.now();
  if (now - lastPlayed < 1500) return false;
  lastPlayed = now;
  const t = ctx.currentTime + 0.01;
  if (kind === "message") {
    note(t, 784, 0.16, 0.09); // G5
    note(t + 0.11, 1175, 0.22, 0.07); // D6
  } else {
    note(t, 988, 0.24, 0.06); // B5
  }
  return true;
}
