import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import "./Button.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, block = false, icon, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn btn--${variant} btn--${size}${block ? " btn--block" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children && <span className="btn__label">{children}</span>}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", className = "", children, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`icon-btn icon-btn--${size} ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
});
