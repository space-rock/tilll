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

export const Badge = ({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
      tones[tone],
      className,
    )}
    {...rest}
  />
);
