import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../cn.js";

type ToastTone = "success" | "danger" | "neutral";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

const ToastContext = createContext<(toast: Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone }) => void>(
  () => undefined,
);

export const useToast = () => useContext(ToastContext);

const icons = { success: CheckCircle2, danger: AlertCircle, neutral: Info } as const;
const iconTones: Record<ToastTone, string> = {
  success: "text-success",
  danger: "text-danger",
  neutral: "text-muted-foreground",
};

/** Short messages in the corner, announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((toast: Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone }) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, tone: "neutral", ...toast }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 6000);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100%-2rem)] flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = icons[item.tone];
          return (
            <div
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3.5 text-sm shadow-pop"
            >
              <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", iconTones[item.tone])} />
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">{item.title}</p>
                {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
