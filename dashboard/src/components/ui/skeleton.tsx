import type { HTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Skeleton = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} {...rest} />
);
