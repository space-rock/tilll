import type { InputHTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Input = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "h-9 w-full rounded-md border border-border bg-card px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50",
      className,
    )}
    {...rest}
  />
);
