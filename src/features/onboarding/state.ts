import { dataSource, type Interest } from "../../data";

/**
 * Joining Amigo: the few steps after a new account is created (confirm email,
 * interests, profile, welcome). Only new accounts see them: the sign-up form
 * (and "Continue with Google" from it) marks this browser before the account
 * exists, and the first signed-in screen claims that mark for the new
 * person. Progress is saved as it goes, so a refresh or a closed app resumes
 * at the same step. Nothing here is a security decision: the server enforces
 * everything an unverified account can or can't do.
 */
export type OnboardingStep = "verify" | "interests" | "profile" | "welcome";
export interface OnboardingProgress {
  step: OnboardingStep;
  interests: Interest[];
  /** When the last verification code was sent (resend cooldown). */
  codeSentAt?: number;
}

const NEW_KEY = "amigo:onboarding:new";
const key = (viewerId: string) => `amigo:onboarding:${viewerId}`;
/** A mark older than this wasn't from a sign-up that just happened. */
const NEW_MARK_MAX_AGE_MS = 30 * 60_000;

const read = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: the steps still work, just without resuming */
  }
};

/** Called just before creating an account (email sign-up, or Google from the sign-up tab). */
export function markNewAccount() {
  write(NEW_KEY, { at: Date.now() });
}

/** This person's unfinished joining steps, if any (claims a fresh sign-up mark). */
export function onboardingFor(viewerId: string, firstStep: OnboardingStep): OnboardingProgress | null {
  const saved = read<OnboardingProgress>(key(viewerId));
  if (saved) return saved;
  const mark = read<{ at: number }>(NEW_KEY);
  if (!mark) return null;
  write(NEW_KEY, null);
  if (Date.now() - mark.at > NEW_MARK_MAX_AGE_MS) return null;
  const fresh: OnboardingProgress = { step: firstStep, interests: [] };
  write(key(viewerId), fresh);
  return fresh;
}

export const saveOnboarding = (viewerId: string, p: OnboardingProgress) => write(key(viewerId), p);
export const finishOnboarding = (viewerId: string) => write(key(viewerId), null);

/** The steps this person goes through (no email step when it's verified already, e.g. Google sign-ups). */
export function onboardingSteps(emailVerified: boolean | undefined): OnboardingStep[] {
  const verify = !!dataSource.emailVerification && emailVerified === false;
  return [...(verify ? (["verify"] as const) : []), ...(dataSource.interests ? (["interests"] as const) : []), "profile", "welcome"];
}

export const INTEREST_LABEL: Record<Interest, string> = {
  technology: "Technology",
  football: "Football",
  music: "Music",
  gaming: "Gaming",
  entertainment: "Entertainment",
  fashion: "Fashion",
  photography: "Photography",
  business: "Business",
  education: "Education",
  science: "Science",
  art: "Art",
  lifestyle: "Lifestyle",
};
