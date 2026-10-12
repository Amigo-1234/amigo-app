import { useRef, useState, type FormEvent } from "react";
import { AuthError, dataSource } from "../data";
import { AuthHeading, AuthLayout, PasswordField, authMessage } from "../features/auth";
import { useFinishRecovery } from "../state/session";
import { Button } from "../ui/Button";

const MIN_PASSWORD = 8;

/** Shown after someone follows a password-reset link. Also how migrated Firebase users can set a password. */
export default function SetPasswordScreen() {
  const finish = useFinishRecovery();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await dataSource.updatePassword(password);
      finish();
    } catch (err) {
      setError(err instanceof AuthError ? authMessage(err.code) : "We couldn't save your password. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthLayout stepKey="set-password">
      <AuthHeading title="Choose a new password" sub="You'll use it to sign in from now on." />
      <form className="auth__form" onSubmit={submit} noValidate>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
        />
        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" block loading={busy} disabled={busy || password.length < MIN_PASSWORD}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  );
}
