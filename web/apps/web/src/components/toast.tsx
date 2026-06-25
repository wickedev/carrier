import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Tiny in-repo toast (no NPM dependency). A `ToastProvider` holds a list of
 * `{ id, message }`, `useToast()` returns a `toast(message)` fn, and a fixed
 * bottom-right portal renders each toast in a polite live region that
 * auto-dismisses after ~5s. Each toast carries a manual dismiss button and
 * pauses its auto-dismiss timer while hovered OR focused, only resuming once
 * both are clear (WCAG 2.2.1). Outside a provider, `toast()` is a no-op so
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

const DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef<Map<number, number>>(new Map());
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // (Re)arm the auto-dismiss countdown for a toast.
  const schedule = React.useCallback(
    (id: number) => {
      const existing = timers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), DISMISS_MS),
      );
    },
    [dismiss],
  );

  // Stop the countdown without removing the toast (hover/focus).
  const pause = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback(
    (message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message }]);
      schedule(id);
    },
    [schedule],
  );

  // Clear any pending dismiss timers on unmount.
  React.useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
              {toasts.map((t) => (
                <ToastItem
                  key={t.id}
                  toast={t}
                  onDismiss={dismiss}
                  onPause={pause}
                  onResume={schedule}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

/**
 * One rendered toast. Tracks hover and focus independently and only resumes the
 * auto-dismiss countdown once BOTH are clear, so releasing one (mouse leaves
 * while the dismiss button is still focused, or vice versa) never restarts the
 * timer prematurely.
 */
function ToastItem({
  toast,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
}) {
  const hovered = React.useRef(false);
  const focused = React.useRef(false);

  const sync = React.useCallback(() => {
    if (hovered.current || focused.current) onPause(toast.id);
    else onResume(toast.id);
  }, [toast.id, onPause, onResume]);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => {
        hovered.current = true;
        sync();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        sync();
      }}
      onFocus={() => {
        focused.current = true;
        sync();
      }}
      onBlur={() => {
        focused.current = false;
        sync();
      }}
      className="pointer-events-auto flex items-start gap-2 border border-line bg-panel px-3 py-2 text-sm text-fg"
    >
      <span>{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 text-fg-subtle hover:text-fg focus-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
