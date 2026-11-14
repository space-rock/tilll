import { cn } from "../../cn.js";

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** A small count after the label, such as how many refunds are waiting. */
  count?: number | undefined;
}

/**
 * Underlined tabs that filter one list. They are buttons that say which is pressed (not a tablist: the panel below
 * is the same list, narrowed), so the list is announced once and the keyboard just tabs through them.
 */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: TabOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      // The bar scrolls sideways when the tabs do not fit (a phone), but never up and down, and shows no scrollbar:
      // nothing inside it may stick out below, or the browser adds a vertical scrollbar.
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              // The underline is drawn inside the button, so it never overlaps the bar's own border.
              active
                ? "text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined && option.count > 0 && (
              <span className="num rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
