import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, MailCheck } from "lucide-react";
import { AuthError, dataSource } from "../data";
import { AuthField, AuthHeading, AuthLayout, CodeField, PasswordField, authMessage } from "../features/auth";
import { Button } from "../ui/Button";
import { LoadingScreen } from "../ui/Loader";

type Step = "signIn" | "signUp" | "reset" | "resetCode" | "resetSent" | "resetDone";

const MIN_PASSWORD = 8;
const codeReset = dataSource.passwordResetByCode;

const errorText = (err: unknown) => authMessage(err instanceof AuthError ? err.code : undefined);

export default function AuthScreen() {
  const [step, setStep] = useState<Step>("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Blocks a second submit before React re-renders the disabled button (double taps).
  const inFlight = useRef(false);

  const go = (next: Step) => {
    setStep(next);
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
    switch (step) {
      case "signIn":
        return run(() => dataSource.signIn(trimmedEmail, password), { entering: true });
      case "signUp":
        return run(
          async () => {
            const { needsEmailConfirmation } = await dataSource.signUp(trimmedEmail, password, name.trim());
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
  const passwordOk = password.length >= MIN_PASSWORD;

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

      {step !== "resetSent" && step !== "resetDone" && (
        <form className="auth__form" onSubmit={submit} noValidate aria-busy={busy}>
          {step === "signUp" && (
            <AuthField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={40} required />
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
              required
            />
          )}
          {step === "resetCode" && <CodeField label="Code from your email" value={code} onChange={setCode} autoFocus />}
          {(step === "signIn" || step === "signUp" || step === "resetCode") && (
            <PasswordField
              label={step === "resetCode" ? "New password" : "Password"}
              autoComplete={step === "signIn" ? "current-password" : "new-password"}
              hint={step === "signIn" ? undefined : `At least ${MIN_PASSWORD} characters.`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
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
            disabled={
              busy ||
              (step !== "resetCode" && !trimmedEmail) ||
              (step === "signIn" && !password) ||
              (step === "signUp" && (!name.trim() || !passwordOk)) ||
              (step === "resetCode" && (code.length < 4 || !passwordOk))
            }
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
    </AuthLayout>
  );
}
