import * as React from "react";
import { Button } from "@carrier/ui";
import { Send, Square } from "lucide-react";
import { Spinner, Toggle } from "../primitives";

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
    <div className="border-t border-line p-2">
      <div className="mb-2 flex items-center gap-1.5 text-xs">
        <span className="text-fg-muted">Delivery:</span>
        <Toggle
          variant="solid"
          grouped
          value={steer ? "steer" : "queue"}
          onChange={(v) => setSteer(v === "steer")}
          options={[
            { value: "queue", label: "Queue", title: "Send after the current step finishes" },
            { value: "steer", label: "Steer", title: "Interrupt the agent and redirect now" },
          ]}
        />
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
          className="min-h-[2.5rem] flex-1 resize-y border border-line bg-transparent px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus-ring disabled:opacity-50"
        />
        <Button
          className="btn-primary"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="Send message"
        >
          {sending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
