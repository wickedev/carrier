import * as React from "react";
import { Button } from "@carrier/ui";
import { Send, Square } from "lucide-react";
import { Spinner, Toggle } from "../primitives";

/** Per-turn overrides carried with a sent message; absent fields use the
 *  session defaults (set in project/org settings). */
export interface SendOptions {
  steer: boolean;
  model?: string;
  effort?: string;
  planMode?: boolean;
}

// Curated per-turn choices. "" / "default" means "no override — use the session
// default". The model list is intentionally small and extensible; settings
// still accepts an arbitrary model string as the session default.
const MODEL_OPTIONS = [
  { value: "", label: "Model: default" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];
const EFFORT_OPTIONS = [
  { value: "", label: "Effort: default" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];
const MODE_OPTIONS = [
  { value: "default", label: "Mode: default" },
  { value: "normal", label: "Normal" },
  { value: "plan", label: "Plan" },
] as const;

type Mode = (typeof MODE_OPTIONS)[number]["value"];

const COMPOSER_SELECT =
  "h-7 max-w-[9rem] border border-line bg-transparent px-1.5 text-2xs text-fg-muted focus-ring";

/**
 * Composer — message input with steer/queue toggle, per-turn model/effort/mode
 * overrides, and interrupt (Req 10.3/10.4). "Steer" interrupts-and-redirects;
 * "Queue" delivers next-cycle. Model/effort/mode left at "default" defer to the
 * session defaults from settings.
 */
export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
}: {
  onSend: (text: string, opts: SendOptions) => void;
  onInterrupt: () => void;
  running: boolean;
  sending?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = React.useState("");
  const [steer, setSteer] = React.useState(false);
  const [model, setModel] = React.useState("");
  const [effort, setEffort] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("default");

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, {
      steer,
      model: model || undefined,
      effort: effort || undefined,
      planMode: mode === "default" ? undefined : mode === "plan",
    });
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
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
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
        <select
          aria-label="Model for this message"
          title="Model — defaults to the session setting"
          className={COMPOSER_SELECT}
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value)}
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Reasoning effort for this message"
          title="Effort — defaults to the session setting"
          className={COMPOSER_SELECT}
          value={effort}
          disabled={disabled}
          onChange={(e) => setEffort(e.target.value)}
        >
          {EFFORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Mode for this message"
          title="Plan mode forbids mutating tools — defaults to the session setting"
          className={COMPOSER_SELECT}
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
          // A free-form prose field, not a form input: suppress browser/OS
          // autofill (incl. macOS "fill code" / one-time-code) and password-
          // manager overlays that otherwise pop up while typing.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
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
