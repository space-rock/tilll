import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../cn.js";

/**
 * A button that opens a small menu of actions. Escape and a click anywhere else close it, and focus returns to the
 * button. `children` is a function so an item can close the menu when it is used.
 */
export function Menu({
  label,
  trigger,
  align = "right",
  className,
  children,
}: {
  /** What the trigger button is called for a screen reader. */
  label: string;
  trigger: ReactNode;
  align?: "left" | "right";
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm font-medium transition-colors hover:bg-muted active:bg-border",
          className,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          className={cn(
            "absolute z-40 mt-1.5 min-w-56 rounded-lg border border-border bg-card p-1 shadow-pop",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const itemClass =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted active:bg-border [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export const MenuItem = ({
  onSelect,
  children,
  className,
}: {
  onSelect: () => void;
  children: ReactNode;
  className?: string;
}) => (
  <button type="button" role="menuitem" onClick={onSelect} className={cn(itemClass, className)}>
    {children}
  </button>
);

export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">{children}</p>
);

export const MenuSeparator = () => <hr className="my-1 border-border" />;
