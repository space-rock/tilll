import { useId, type InputHTMLAttributes } from "react";
import { cn } from "../../cn.js";
import { Input } from "./input.js";

/** A labelled input. The label is tied to the input, and a hint or an error is read out with it. */
export function TextField({
  label,
  hint,
  error,
  suffix,
  className,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string | undefined;
  /** A unit shown after the input, like "minutes" or "USDC". */
  suffix?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ");
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy || undefined} {...input} />
        {suffix && <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
