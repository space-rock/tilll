import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../cn.js";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

// Primary is navy with white text. Every look changes colour on hover and when pressed, and a disabled button is
// greyed out and says so with its cursor, instead of fading, so it never looks half-active.
const variants: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:bg-disabled disabled:text-disabled-foreground",
  outline:
    "border border-border bg-card hover:bg-muted active:bg-border disabled:bg-card disabled:text-disabled-foreground",
  ghost: "hover:bg-muted active:bg-border disabled:text-disabled-foreground",
  danger:
    "bg-danger-solid text-white hover:bg-danger-solid-hover active:bg-danger-solid-active disabled:bg-disabled disabled:text-disabled-foreground",
};
const sizes: Record<Size, string> = { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm" };

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
}
