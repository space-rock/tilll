import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../cn.js";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

// Primary is navy with white text. Every look changes colour on hover and when pressed, and a disabled button is
// greyed out and says so with its cursor, instead of fading, so it never looks half-active.
const variants: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:bg-disabled disabled:text-disabled-foreground",
  outline:
    "border border-border bg-card shadow-card hover:bg-muted active:bg-border disabled:bg-card disabled:text-disabled-foreground",
  ghost: "hover:bg-muted active:bg-border disabled:text-disabled-foreground",
  danger:
    "bg-danger-solid text-white hover:bg-danger-solid-hover active:bg-danger-solid-active disabled:bg-disabled disabled:text-disabled-foreground",
};
const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-9 gap-2 px-4 text-sm",
  icon: "h-9 w-9 text-sm",
};

/** `loading` keeps the button's size, shows a spinner and cannot be pressed again. */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
