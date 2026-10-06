import { useState, type FormEvent } from "react";
import { dataSource } from "../data";
import { Wordmark } from "../ui/Brand";
import { Button } from "../ui/Button";
import "./AuthScreen.css";

type Mode = "signIn" | "signUp" | "reset";

function authMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "That email and password don't match. Try again or reset your password.";
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/email-already-in-use":
      return "There's already an account with this email. Sign in instead.";
    case "auth/weak-password":
      return "Use at least 6 characters for your password.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/network-request-failed":
      return "Can't reach Amigo right now. Check your connection.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signIn") await dataSource.signIn(email.trim(), password);
      else if (mode === "signUp") await dataSource.signUp(email.trim(), password, name);
      else {
        await dataSource.sendPasswordReset(email.trim());
        setNotice("If there's an account for that email, a reset link is on its way.");
      }
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === "signIn" ? "Welcome back" : mode === "signUp" ? "Join Amigo" : "Reset your password";
  const sub =
    mode === "signIn"
      ? "Sign in to catch up with your people."
      : mode === "signUp"
        ? "Posts, moments and conversations with the people you actually like."
        : "Enter your email and we'll send you a link.";

  return (
    <div className="auth">
      <div className="auth__panel">
        <Wordmark />
        <h1 className="auth__title">{heading}</h1>
        <p className="auth__sub">{sub}</p>

        <form className="auth__form" onSubmit={submit} noValidate>
          {mode === "signUp" && (
            <label className="field">
              <span className="field__label">Name</span>
              <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={40} />
            </label>
          )}
          <label className="field">
            <span className="field__label">Email</span>
            <input
              className="field__input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          {mode !== "reset" && (
            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="field__input"
                type="password"
                autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>
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
            disabled={!email.trim() || (mode !== "reset" && !password) || (mode === "signUp" && !name.trim())}
          >
            {mode === "signIn" ? "Sign in" : mode === "signUp" ? "Create account" : "Send reset link"}
          </Button>
        </form>

        <div className="auth__switch">
          {mode === "signIn" && (
            <>
              <button className="auth__link" onClick={() => switchMode("reset")}>
                Forgot password?
              </button>
              <span>
                New here?{" "}
                <button className="auth__link auth__link--strong" onClick={() => switchMode("signUp")}>
                  Create an account
                </button>
              </span>
            </>
          )}
          {mode !== "signIn" && (
            <span>
              {mode === "signUp" ? "Already have an account? " : ""}
              <button className="auth__link auth__link--strong" onClick={() => switchMode("signIn")}>
                {mode === "signUp" ? "Sign in" : "Back to sign in"}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
