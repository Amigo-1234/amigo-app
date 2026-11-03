import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import "./AuthInputs.css";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { label: string; hint?: string; error?: string };

/** Screen-reader links for a field's hint and error. */
function describedBy(id: string, hint?: string, error?: string) {
  return [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
}

/** The field's own error, under it (announced when it appears). */
function FieldError({ id, error }: { id: string; error?: string }) {
  return error ? (
    <p id={`${id}-error`} className="auth-field__error" role="alert">
      {error}
    </p>
  ) : null;
}

/** Labelled text field with an optional hint and error, wired for screen readers. */
export function AuthField({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>{label}</label>
      <input id={id} className="auth-field__input" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...input} />
      <FieldError id={id} error={error} />
      {hint && !error && <p id={`${id}-hint`} className="auth-field__hint">{hint}</p>}
    </div>
  );
}

/** Password field with a show/hide toggle. */
export function PasswordField({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>{label}</label>
      <div className="auth-field__wrap">
        <input
          id={id}
          className="auth-field__input auth-field__input--pw"
          type={shown ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...input}
        />
        <button type="button" className="auth-field__eye" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}>
          {shown ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      <FieldError id={id} error={error} />
      {hint && !error && <p id={`${id}-hint`} className="auth-field__hint">{hint}</p>}
    </div>
  );
}

/** One-time code from email: digits only, large and spaced, autofill-friendly. */
export function CodeField({ label = "Code", value, onChange, autoFocus, error }: { label?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; error?: string }) {
  const id = useId();
  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="auth-field__input auth-field__input--code"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={8}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      />
      <FieldError id={id} error={error} />
    </div>
  );
}

/** Shared auth error wording (codes come from the data layer). */
export function authMessage(code: string | undefined): string {
  switch (code) {
    case "invalid-credentials":
      return "That email and password don't match. Try again or reset your password.";
    case "invalid-email":
      return "That doesn't look like a valid email address.";
    case "email-in-use":
      return "There's already an account with this email. Sign in instead.";
    case "weak-password":
      return "Choose a longer password — at least 8 characters.";
    case "email-not-confirmed":
      return "Confirm your email first — check your inbox.";
    case "invalid-code":
      return "That code is wrong or has expired. Check it, or send a new one.";
    case "rate-limited":
      return "Too many attempts. Wait a moment and try again.";
    case "network":
      return "Can't reach Amigo right now. Check your connection.";
    default:
      return "Something went wrong. Please try again.";
  }
}
