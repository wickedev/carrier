import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Tiny in-repo toast (no NPM dependency). A `ToastProvider` holds a list of
 * `{ id, message }`, `useToast()` returns a `toast(message)` fn, and a fixed
 * bottom-right portal renders each toast in a polite live region that
 * auto-dismisses after ~2.5s. Outside a provider, `toast()` is a no-op so
 * components (and their unit tests) work without wrapping.
 */
interface Toast {
  id: number;
  message: string;
}

const ToastContext = React.createContext<(message: string) => void>(() => {});

export function useToast(): (message: string) => void {
  return React.useContext(ToastContext);
}

const DISMISS_MS = 2500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef<number[]>([]);
  const nextId = React.useRef(0);

  const toast = React.useCallback((message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message }]);
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DISMISS_MS);
    timers.current.push(timer);
  }, []);

  // Clear any pending dismiss timers on unmount.
  React.useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  role="status"
                  aria-live="polite"
                  className="pointer-events-auto rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-md dark:border-neutral-800 dark:bg-neutral-900"
                >
                  {t.message}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}
