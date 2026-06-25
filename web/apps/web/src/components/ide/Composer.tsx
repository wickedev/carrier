import * as React from "react";
import { Button, cn } from "@carrier/ui";
import {
  Send,
  Square,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Check,
  Brain,
  Play,
  Bot,
} from "lucide-react";
import { Spinner } from "../primitives";

/** Per-turn overrides carried with a sent message; absent fields use the
 *  session defaults (set in project/org settings). */
export interface SendOptions {
  steer: boolean;
  model?: string;
  effort?: string;
  planMode?: boolean;
}

/** The session's resolved default model params, shown as the real current
 *  values (never the word "default"). */
export interface SessionDefaults {
  model: string;
  effort: string;
  planMode: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};
const shortModel = (m: string) => MODEL_LABELS[m] ?? m;

// Models grouped by provider for the cascading MODEL submenu. The session's
// actual default model is merged in (under its provider) so a custom model from
// settings still shows and stays selectable.
const BASE_MODEL_GROUPS: { provider: string; models: string[] }[] = [
  {
    provider: "Claude",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
];
const providerOf = (m: string): string =>
  m.startsWith("claude")
    ? "Claude"
    : /^(gpt|o\d|chatgpt|codex)/.test(m)
      ? "OpenAI"
      : m.startsWith("gemini")
        ? "Google"
        : "Custom";

// "" effort = the provider's adaptive default; shown as "auto", not blank.
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const effortLabel = (e: string) => (e === "" ? "auto" : e);

const MODE_ITEMS: { plan: boolean; label: string; Icon: typeof Play }[] = [
  { plan: false, label: "Normal", Icon: Play },
  { plan: true, label: "Plan", Icon: Brain },
];

const SECTION = "px-3 pb-1 pt-2 text-2xs uppercase tracking-wide text-fg-subtle";
const ITEM =
  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm text-fg hover:bg-bg focus-ring";
const DIVIDER = "my-1 border-t border-line";

/**
 * Composer — message input for the agent.
 *
 * One settings button (⚙) opens a multi-level context menu: flat MODE and EFFORT
 * sections with a checkmark on the active value, and a MODEL section whose
 * provider rows open a submenu of that provider's models. The button face shows
 * the *real* effective values. Delivery is automatic — idle sends a turn
 * immediately; while running the message queues by default, with a Steer action
 * to interrupt and redirect now.
 */
export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
  defaults,
}: {
  onSend: (text: string, opts: SendOptions) => void;
  onInterrupt: () => void;
  running: boolean;
  sending?: boolean;
  disabled?: boolean;
  defaults: SessionDefaults;
}) {
  const [text, setText] = React.useState("");
  // null = not overridden → use the session default (shown as its real value).
  const [modelOverride, setModelOverride] = React.useState<string | null>(null);
  const [effortOverride, setEffortOverride] = React.useState<string | null>(null);
  const [planOverride, setPlanOverride] = React.useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  // Effective (displayed) values: the override if set, else the real default.
  const effModel = modelOverride ?? defaults.model;
  const effEffort = effortOverride ?? defaults.effort;
  const effPlan = planOverride ?? defaults.planMode;

  const modelGroups = React.useMemo(() => {
    const groups = BASE_MODEL_GROUPS.map((g) => ({ provider: g.provider, models: [...g.models] }));
    if (defaults.model && !groups.some((g) => g.models.includes(defaults.model))) {
      const p = providerOf(defaults.model);
      const existing = groups.find((g) => g.provider === p);
      if (existing) existing.models.unshift(defaults.model);
      else groups.unshift({ provider: p, models: [defaults.model] });
    }
    return groups;
  }, [defaults.model]);

  // Close the popover on outside click / Escape.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Send. Only fields the user actually changed ride the wire; the rest fall
  // back to the session defaults in the runtime.
  const submit = (steer: boolean) => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, {
      steer,
      model: modelOverride ?? undefined,
      effort: effortOverride ?? undefined,
      planMode: planOverride ?? undefined,
    });
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl+Enter uses the default delivery (Queue while running, immediate
    // when idle) — Steer is always an explicit click.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(false);
    }
  };

  const canSend = !disabled && !!text.trim();

  return (
    <div className="border-t border-line p-2">
      <div className="mb-2 flex items-center gap-2 text-xs">
        {/* Single button → multi-level menu, exposing the real effective config. */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="inline-flex items-center gap-1.5 border border-line px-2 py-1 text-2xs text-fg-muted hover:text-fg focus-ring"
            title="Model · effort · mode for messages (defaults from settings)"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            <span className="font-mono">
              {shortModel(effModel)} · {effortLabel(effEffort)} · {effPlan ? "Plan" : "Normal"}
            </span>
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-20 mb-1 w-56 border border-line bg-panel py-1"
            >
              {/* MODE */}
              <p className={SECTION}>Mode</p>
              {MODE_ITEMS.map(({ plan, label, Icon }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effPlan === plan}
                  onClick={() => setPlanOverride(plan)}
                  className={cn(ITEM, effPlan === plan && "text-accent")}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" aria-hidden /> {label}
                  </span>
                  {effPlan === plan ? <Check className="h-4 w-4" aria-hidden /> : null}
                </button>
              ))}

              <div className={DIVIDER} />

              {/* EFFORT */}
              <p className={SECTION}>Effort</p>
              {EFFORTS.map((e) => (
                <button
                  key={e || "auto"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effEffort === e}
                  onClick={() => setEffortOverride(e)}
                  className={cn(ITEM, effEffort === e && "text-accent")}
                >
                  <span>{effortLabel(e)}</span>
                  {effEffort === e ? <Check className="h-4 w-4" aria-hidden /> : null}
                </button>
              ))}

              <div className={DIVIDER} />

              {/* MODEL — provider rows open a submenu of that provider's models. */}
              <p className={SECTION}>Model</p>
              {modelGroups.map((g) => {
                const groupActive = g.models.includes(effModel);
                return (
                  <div key={g.provider} className="group relative">
                    <button
                      type="button"
                      aria-haspopup="menu"
                      className={cn(ITEM, groupActive && "text-accent")}
                    >
                      <span className="flex items-center gap-2">
                        <Bot className="h-4 w-4" aria-hidden /> {g.provider}
                      </span>
                      <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
                    </button>
                    {/* -ml-px keeps the hover bridge gapless so the flyout stays open. */}
                    <div
                      role="menu"
                      className="absolute left-full top-0 z-30 -ml-px hidden min-w-44 border border-line bg-panel py-1 group-hover:block"
                    >
                      {g.models.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="menuitemradio"
                          aria-checked={effModel === m}
                          onClick={() => setModelOverride(m)}
                          className={cn(ITEM, effModel === m && "text-accent")}
                        >
                          <span>{shortModel(m)}</span>
                          {effModel === m ? <Check className="h-4 w-4" aria-hidden /> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              {running ? (
                <>
                  <div className={DIVIDER} />
                  <button
                    type="button"
                    onClick={() => {
                      onInterrupt();
                      setMenuOpen(false);
                    }}
                    className={cn(ITEM, "text-danger")}
                  >
                    <span className="flex items-center gap-2">
                      <Square className="h-3.5 w-3.5" aria-hidden /> Interrupt agent
                    </span>
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {running ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-2xs uppercase tracking-wide text-success">
            <Spinner /> Agent running
          </span>
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
        {running ? (
          // Mid-turn: queue by default, or steer (interrupt + redirect now).
          <div className="flex flex-col gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => submit(true)}
              disabled={!canSend}
              title="Interrupt the agent and redirect now"
              aria-label="Steer the agent"
            >
              Steer
            </Button>
            <Button
              className="btn-primary"
              size="sm"
              onClick={() => submit(false)}
              disabled={!canSend}
              title="Send after the current step finishes"
              aria-label="Queue message"
            >
              {sending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
        ) : (
          <Button
            className="btn-primary"
            onClick={() => submit(false)}
            disabled={!canSend}
            aria-label="Send message"
          >
            {sending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
          </Button>
        )}
      </div>
    </div>
  );
}
