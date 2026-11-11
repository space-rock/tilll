import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../cn.js";

export const Table = ({ className, ...rest }: HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full caption-bottom text-sm", className)} {...rest} />
  </div>
);
export const THead = (props: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className="border-b border-border" {...props} />
);
export const TBody = (props: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />;
export const TR = ({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn("border-b border-border last:border-0", className)} {...rest} />
);
export const TH = ({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground",
      className,
    )}
    {...rest}
  />
);
export const TD = ({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("px-3 py-2.5 align-middle", className)} {...rest} />
);
