import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Table = ({ className, ...rest }: HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full caption-bottom text-sm", className)} {...rest} />
  </div>
);
export const THead = (props: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className="border-b border-border bg-muted/50" {...props} />
);
export const TBody = (props: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />;
export const TR = ({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn("border-b border-border transition-colors last:border-0", className)} {...rest} />
);
export const TH = ({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      "h-9 px-4 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5",
      className,
    )}
    {...rest}
  />
);
export const TD = ({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("px-4 py-3 align-middle first:pl-5 last:pr-5", className)} {...rest} />
);
