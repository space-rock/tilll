import type { HTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Card = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("rounded-lg border border-border bg-card text-foreground shadow-card", className)} {...rest} />
);
export const CardHeader = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 px-5 pt-4 pb-2", className)} {...rest} />
);
export const CardTitle = ({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn("text-sm font-semibold tracking-tight", className)} {...rest} />
);
export const CardDescription = ({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-xs text-muted-foreground", className)} {...rest} />
);
export const CardContent = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-5 pt-2 pb-5", className)} {...rest} />
);
