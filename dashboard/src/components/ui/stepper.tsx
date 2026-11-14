import { Check } from "lucide-react";
import { cn } from "../../cn.js";

export interface Step {
  label: string;
}

/** Where a task is: steps before the current one are done, the current one is marked, the rest are still to come. */
export function Stepper({ steps, current, failed = false }: { steps: Step[]; current: number; failed?: boolean }) {
  return (
    <ol aria-label="Progress" className="flex items-center gap-2">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step.label} aria-current={active ? "step" : undefined} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                done && "bg-primary text-primary-foreground",
                active && !failed && "border-2 border-primary text-foreground",
                active && failed && "border-2 border-danger text-danger",
                !done && !active && "border border-border text-muted-foreground",
              )}
            >
              {done ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className={cn("text-xs", active ? "font-medium text-foreground" : "text-muted-foreground")}>
              {step.label}
            </span>
            {index < steps.length - 1 && <span aria-hidden="true" className="h-px flex-1 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}
