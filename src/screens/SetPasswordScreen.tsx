import { useState, type FormEvent } from "react";
import { AuthError, dataSource } from "../data";
import { useFinishRecovery } from "../state/session";
import { Wordmark } from "../ui/Brand";
import { Button } from "../ui/Button";
import "./AuthScreen.css";

/** Shown after someone follows a password-reset link. Also how migrated Firebase users can set a password. */
export default function SetPasswordScreen() {
  const finish = useFinishRecovery();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await dataSource.updatePassword(password);
      finish();
    } catch (err) {
      setError(err instanceof AuthError && err.code === "weak-password" ? "Use at least 6 characters for your password." : "We couldn't save your password. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <Wordmark />
        <h1 className="auth__title">Choose a new password</h1>
        <p className="auth__sub">You'll use it to sign in from now on.</p>
        <form className="auth__form" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">New password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              autoFocus
            />
          </label>
          {error && (
            <p className="auth__error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" block loading={busy} disabled={password.length < 6}>
            Save password
          </Button>
        </form>
      </div>
    </div>
  );
}
