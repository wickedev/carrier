import * as React from "react";
import { Button } from "@carrier/ui";
import { cn } from "@carrier/ui";
import { Send, Square } from "lucide-react";
import { Spinner } from "../primitives";

/**
 * Composer — message input with steer/queue toggle and interrupt (Req 10.3/10.4).
 * "Steer" interrupts-and-redirects; "Queue" delivers next-cycle.
 */
export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
}: {
  onSend: (text: string, steer: boolean) => void;
  onInterrupt: () => void;
  running: boolean;
  sending?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = React.useState("");
  const [steer, setSteer] = React.useState(false);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, steer);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
      <div className="mb-2 flex items-center gap-1.5 text-xs">
        <span className="text-neutral-400">Delivery:</span>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
          <button
            type="button"
            aria-pressed={!steer}
            onClick={() => setSteer(false)}
            className={cn(
              "px-2 py-0.5",
              !steer
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-500",
            )}
          >
            Queue
          </button>
          <button
            type="button"
            aria-pressed={steer}
            onClick={() => setSteer(true)}
            className={cn(
              "px-2 py-0.5",
              steer
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-500",
            )}
          >
            Steer
          </button>
        </div>
        {running ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onInterrupt}
            aria-label="Interrupt session"
          >
            <Square className="h-3.5 w-3.5" aria-hidden /> Interrupt
          </Button>
        ) : null}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message to agent"
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the agent…  (⌘/Ctrl+Enter to send)"
          className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <Button onClick={submit} disabled={disabled || !text.trim()} aria-label="Send message">
          {sending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
