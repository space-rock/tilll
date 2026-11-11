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

const tones: Record<ToastTone, string> = {
  success: "border-success",
  danger: "border-danger",
  neutral: "border-border",
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
        className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2"
      >
        {items.map((item) => (
          <div key={item.id} className={cn("rounded-md border-l-4 bg-card p-3 text-sm shadow-lg", tones[item.tone])}>
            <p className="font-medium">{item.title}</p>
            {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
