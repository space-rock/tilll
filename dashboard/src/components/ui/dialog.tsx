import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../cn.js";

/**
 * A modal built on the browser's own <dialog>: it traps focus, closes on Escape and marks the rest of the page inert,
 * which is why no UI library is needed. `side="right"` makes it a sheet.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  side?: "right";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "bg-card p-0 text-foreground shadow-lg",
        side === "right"
          ? "m-0 ml-auto h-dvh max-h-none w-full max-w-xl border-l border-border"
          : "m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-border",
      )}
    >
      {open && (
        <div className="flex max-h-dvh flex-col gap-4 overflow-y-auto p-5">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
