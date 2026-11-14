import type { HTMLAttributes } from "react";
import { cn } from "../../cn.js";
import type { Tone } from "../../format.js";

const tones: Record<Tone, string> = {
  success: "bg-success-bg text-success",
  neutral: "bg-muted text-foreground",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
  danger: "bg-danger-bg text-danger",
  muted: "bg-muted text-muted-foreground",
};

/** The dot takes the badge's own colour, so a status reads at a glance even in a long table. */
export const Badge = ({
  tone = "neutral",
  dot = true,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
      tones[tone],
      className,
    )}
    {...rest}
  >
    {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
    {children}
  </span>
);
