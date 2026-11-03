import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ArrowLeft, MailCheck } from "lucide-react";
import { AuthError, dataSource } from "../data";
import { AuthField, AuthHeading, AuthLayout, CodeField, PasswordField, authMessage } from "../features/auth";
import { Button } from "../ui/Button";
import { LoadingScreen } from "../ui/Loader";
import { BUNDLED_VERSION, LEGAL_DOCS, MIN_AGE } from "../legal";
import { legalCurrent } from "./LegalScreen";
import { markNewAccount } from "../features/onboarding/state";
import "./LegalScreen.css";

/** [OWNER/LEGAL] Minimum age in the draft Terms — confirm before launch. */

type Step = "signIn" | "signUp" | "reset" | "resetCode" | "resetSent" | "resetDone";

const MIN_PASSWORD = 8;
const codeReset = dataSource.passwordResetByCode;
const social = dataSource.socialSignIn?.providers.includes("google") ? dataSource.socialSignIn : null;

/** Google's "G" mark (their brand guidelines ask for it on sign-in buttons). */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const errorText = (err: unknown) => authMessage(err instanceof AuthError ? err.code : undefined);

/**
 * Back from Google without a session: Neon Auth sends the browser to /?auth_error=google&error=<code>
 * (src/data/supabase/neonClient.ts), or back with a verifier that couldn't be exchanged. Read once per page load (it is one), then removed from the
 * address bar.
 */
let socialError: string | null | undefined;
function takeSocialError(): string | null {
  if (socialError !== undefined) return socialError;
  socialError = readSocialError();
  // The same answer for this render (StrictMode asks twice), then never again this page load.
  setTimeout(() => (socialError = null), 0);
  return socialError;
}
function readSocialError(): string | null {
  const url = new URL(location.href);
  // Back from Google with a session verifier, yet signed out (this screen only shows then):
  // exchanging it failed. Say so, and drop it (a reload would only fail again).
  const verifierFailed = url.searchParams.has("neon_auth_session_verifier");
  if (!url.searchParams.has("auth_error") && !verifierFailed) return null;
  const code = url.searchParams.get("error") ?? "";
  url.searchParams.delete("neon_auth_session_verifier");
  url.searchParams.delete("auth_error");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  if (code === "access_denied") return "Google sign-in was cancelled. You can try again, or sign in with email.";
  return "Google sign-in didn't finish. Try again, or sign in with email.";
}

export default function AuthScreen() {
  const [step, setStep] = useState<Step>("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(takeSocialError);
  const [notice, setNotice] = useState<string | null>(null);
  // One tick covers age, Terms, Guidelines and Privacy Policy; both documents are still recorded as accepted.
  const [agree, setAgree] = useState(false);
  // Field messages show once someone tries to continue, not while they're still typing.
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [versions, setVersions] = useState({ terms: BUNDLED_VERSION.terms, privacy: BUNDLED_VERSION.privacy });
  useEffect(() => {
    void legalCurrent().then((list) => {
      const v = (slug: "terms" | "privacy") => list?.find((d) => d.slug === slug)?.version ?? BUNDLED_VERSION[slug];
      setVersions({ terms: v("terms"), privacy: v("privacy") });
    });
  }, []);
  // Blocks a second submit before React re-renders the disabled button (double taps).
  const inFlight = useRef(false);

  const go = (next: Step) => {
    setStep(next);
    setAttempted(false);
    setError(null);
    setNotice(null);
    if (next !== "resetCode") setCode("");
  };

  async function run(action: () => Promise<void>, opts: { entering?: boolean } = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    if (opts.entering) setEntering(true);
    try {
      await action();
    } catch (err) {
      setEntering(false);
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const trimmedEmail = email.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(problems).length) {
      setAttempted(true);
      // Move to the first thing that needs fixing (after the messages render).
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    switch (step) {
      case "signIn":
        return run(() => dataSource.signIn(trimmedEmail, password), { entering: true });
      case "signUp":
        return run(
          async () => {
            // The joining steps (confirm email, interests, profile) follow once the account exists.
            markNewAccount();
            const { needsEmailConfirmation } = await dataSource.signUp(trimmedEmail, password, name.trim(), {
              acceptLegal: [
                { slug: "terms", version: versions.terms },
                { slug: "privacy", version: versions.privacy },
              ],
            });
            if (needsEmailConfirmation) {
              setEntering(false);
              go("signIn");
              setNotice("Check your inbox — confirm your email, then sign in.");
            }
          },
          { entering: true },
        );
      case "reset":
        return run(async () => {
          if (codeReset) {
            await codeReset.send(trimmedEmail);
            go("resetCode");
          } else {
            await dataSource.sendPasswordReset(trimmedEmail);
            go("resetSent");
          }
        });
      case "resetCode":
        return run(async () => {
          await codeReset!.reset(trimmedEmail, code, password);
          setPassword("");
          go("resetDone");
        });
    }
  }

  async function resendResetCode() {
    await run(async () => {
      await codeReset!.send(trimmedEmail);
      setNotice(`New code sent to ${trimmedEmail}.`);
    });
  }

  if (entering) return <LoadingScreen label="Signing you in" message={step === "signUp" ? "Creating your account…" : "Signing you in…"} />;

  const tabs = step === "signIn" || step === "signUp";
  const newPassword = step === "signUp" || step === "resetCode";
  const missing = MIN_PASSWORD - password.length;
  // What's still needed, per field. Shown only after a first attempt to continue.
  const problems: Partial<Record<"name" | "email" | "password" | "code" | "agree", string>> = {};
  if (step === "signUp" && !name.trim()) problems.name = "Enter your name. It's shown on your profile.";
  if (step !== "resetCode") {
    if (!trimmedEmail) problems.email = "Enter your email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) problems.email = "That doesn't look like a valid email address.";
  }
  if (step === "signIn" && !password) problems.password = "Enter your password.";
  if (newPassword && missing > 0) problems.password = `Use at least ${MIN_PASSWORD} characters${password ? ` (${missing} more)` : ""}.`;
  if (step === "resetCode" && code.length < 4) problems.code = "Enter the code from your email.";
  if (step === "signUp" && !agree) problems.agree = `Please confirm you're ${MIN_AGE} or older and agree to continue.`;
  const shown = attempted ? problems : {};
  const passwordHint = !newPassword ? undefined : !password ? `At least ${MIN_PASSWORD} characters.` : missing > 0 ? `${missing} more character${missing === 1 ? "" : "s"} needed.` : "Good length.";

  return (
    <AuthLayout stepKey={step}>
      {tabs && (
        <div className="auth-tabs" role="group" aria-label="Account">
          <button type="button" className="auth-tabs__tab" aria-pressed={step === "signIn"} onClick={() => go("signIn")}>
            Sign in
          </button>
          <button type="button" className="auth-tabs__tab" aria-pressed={step === "signUp"} onClick={() => go("signUp")}>
            Create account
          </button>
        </div>
      )}

      {!tabs && step !== "resetDone" && (
        <button type="button" className="auth__back" onClick={() => go("signIn")}>
          <ArrowLeft size={18} aria-hidden="true" /> Back to sign in
        </button>
      )}

      {step === "signIn" && <AuthHeading title="Welcome back" sub="Sign in to catch up with your people." />}
      {step === "signUp" && <AuthHeading title="Join Amigo" sub="Posts, Worlds and conversations with the people you actually like." />}
      {step === "reset" && (
        <AuthHeading title="Reset your password" sub={codeReset ? "We'll email you a code to set a new password." : "We'll email you a link to set a new password."} />
      )}
      {step === "resetCode" && (
        <AuthHeading
          title="Check your email"
          sub={
            <>
              Enter the code we sent to <strong>{trimmedEmail}</strong> and choose a new password.
            </>
          }
        />
      )}

      {(step === "resetSent" || step === "resetDone") && (
        <div className="auth-done">
          <span className="auth-done__icon" aria-hidden="true">
            <MailCheck size={26} />
          </span>
          <AuthHeading
            title={step === "resetSent" ? "Check your email" : "Password updated"}
            sub={step === "resetSent" ? `If there's an account for ${trimmedEmail}, a reset link is on its way.` : "Sign in with your new password."}
          />
          <Button size="lg" block onClick={() => go("signIn")}>
            Back to sign in
          </Button>
        </div>
      )}

      {social && tabs && (
        <div className="auth__social">
          <button
            type="button"
            className="auth-social"
            disabled={busy}
            onClick={() =>
              run(async () => {
                // New accounts made this way get the joining steps too (Google has confirmed the email).
                if (step === "signUp") markNewAccount();
                await social.start("google");
              })
            }
          >
            <GoogleMark />
            Continue with Google
          </button>
          {step === "signUp" && (
            <p className="auth__social-note">
              Amigo is for people {MIN_AGE} or older. By continuing with Google you agree to the <Link to="/legal/terms">Terms</Link> and <Link to="/legal/privacy">Privacy Policy</Link> — on the next screen you'll confirm your age and accept them.
            </p>
          )}
          <p className="auth__or">
            <span>or with email</span>
          </p>
        </div>
      )}

      {step !== "resetSent" && step !== "resetDone" && (
        <form ref={formRef} className="auth__form" onSubmit={submit} noValidate aria-busy={busy}>
          {step === "signUp" && (
            <AuthField label="Your name" hint="Shown on your profile. You can change it later." error={shown.name} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={40} required />
          )}
          {step !== "resetCode" && (
            <AuthField
              label="Email"
              type="email"
              inputMode="email"
              autoComplete={step === "signUp" ? "email" : "username"}
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={shown.email}
              required
            />
          )}
          {step === "resetCode" && <CodeField label="Code from your email" value={code} onChange={setCode} autoFocus error={shown.code} />}
          {(step === "signIn" || step === "signUp" || step === "resetCode") && (
            <PasswordField
              label={step === "resetCode" ? "New password" : "Password"}
              autoComplete={step === "signIn" ? "current-password" : "new-password"}
              hint={passwordHint}
              error={shown.password}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}

          {step === "signUp" && (
            <div className="auth-consent">
              <label className="auth-check">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-invalid={shown.agree ? true : undefined} required />
                <span>
                  I'm {MIN_AGE} or older. I agree to the{" "}
                  <Link to="/legal/terms" target="_blank" rel="noopener">
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link to="/legal/guidelines" target="_blank" rel="noopener">
                    Community Guidelines
                  </Link>
                  , and I've read the{" "}
                  <Link to="/legal/privacy" target="_blank" rel="noopener">
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
              {shown.agree && (
                <p className="auth-field__error" role="alert">
                  {shown.agree}
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="auth__error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="auth__notice" role="status">
              {notice}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            block
            loading={busy}
            disabled={busy}
          >
            {step === "signIn" ? "Sign in" : step === "signUp" ? "Create account" : step === "reset" ? (codeReset ? "Send code" : "Send reset link") : "Set new password"}
          </Button>

          {step === "signIn" && (
            <button type="button" className="auth__link" onClick={() => go("reset")}>
              Forgot password?
            </button>
          )}
          {step === "resetCode" && (
            <button type="button" className="auth__link" onClick={resendResetCode} disabled={busy}>
              Send a new code
            </button>
          )}
        </form>
      )}
      <nav className="legal-links auth__legal" aria-label="Legal">
        {LEGAL_DOCS.filter((d) => ["terms", "privacy", "guidelines", "cookies"].includes(d.slug)).map((d) => (
          <Link key={d.slug} to={`/legal/${d.slug}`}>
            {d.title}
          </Link>
        ))}
      </nav>
    </AuthLayout>
  );
}
