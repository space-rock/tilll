import type { HTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Card = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("rounded-lg border border-border bg-card text-foreground shadow-xs", className)} {...rest} />
);
export const CardHeader = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...rest} />
);
export const CardTitle = ({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn("text-sm font-semibold", className)} {...rest} />
);
export const CardDescription = ({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-xs text-muted-foreground", className)} {...rest} />
);
export const CardContent = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-4 pt-2", className)} {...rest} />
);
