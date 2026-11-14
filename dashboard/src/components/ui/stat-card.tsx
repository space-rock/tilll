import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../cn.js";
import { Card } from "./card.js";

/** One number that matters, with an icon, a label and a line of context. */
export function StatCard({
  icon: Icon,
  label,
  children,
  footer,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col gap-3 p-5", className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-foreground">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        {label}
      </div>
      <p className="num font-display text-2xl font-semibold tracking-tight">{children}</p>
      {footer && <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">{footer}</div>}
    </Card>
  );
}
