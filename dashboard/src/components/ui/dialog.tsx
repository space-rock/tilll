import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../cn.js";

/**
 * A modal built on the browser's own <dialog>: it traps focus, closes on Escape and marks the rest of the page inert,
 * which is why no UI library is needed. `side` makes it a sheet that slides in from that edge.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  side,
  hideTitle = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  side?: "left" | "right";
  /** Keep the title for screen readers but do not show it (a navigation drawer). */
  hideTitle?: boolean;
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
        "bg-card p-0 text-foreground shadow-pop",
        side === "right" && "m-0 ml-auto h-dvh max-h-none w-full max-w-xl border-l border-border",
        side === "left" && "m-0 mr-auto h-dvh max-h-none w-72 max-w-[85vw] border-r border-border",
        !side && "m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border",
      )}
    >
      {open && (
        <div className="flex max-h-dvh flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <div className={cn("flex flex-col gap-1", hideTitle && "sr-only")}>
              <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight">
                {title}
              </h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-1 -mr-1 ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
