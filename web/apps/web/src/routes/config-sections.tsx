import * as React from "react";
import type { ConfigScope, HookEvent, ModelParams } from "@carrier/contract";
import { Button } from "@carrier/ui";
import { Plus, Loader2 } from "lucide-react";
import { Card, Badge, Input, Loading } from "../components/primitives";
import { ConfigSection, DeleteButton, EnableToggle } from "../components/config-controls";
import { useToast } from "../components/toast";
import {
  useConfigList,
  useCreateConfig,
  useUpdateConfig,
  useRemoveConfig,
  useModelParams,
  usePutModelParams,
} from "../api/queries";

/**
 * Reusable configuration sections rendered on both the Org and Project settings
 * pages. Each section is a self-contained `Card` with an add-form (gated by
 * `manage`) plus a list whose rows expose an enable toggle and a delete control.
 * All sections share the same `{ scope, ownerKey, manage }` props; `scope`
 * selects the org-vs-project REST base and `ownerKey` is the org slug or project
 * id (the BFF resolves either).
 */
export interface SectionProps {
  scope: ConfigScope;
  ownerKey: string;
  manage: boolean;
}

// ── Shared styling helpers (mirror settings.tsx form controls) ────────────────

const SELECT_CLASS =
  "h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950";

/** Parse a comma/space-separated list into trimmed, non-empty tokens. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a comma-separated list (preserves spaces inside an item). */
function splitCommas(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Agents ────────────────────────────────────────────────────────────────────

export function AgentsSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "agents");
  const create = useCreateConfig(scope, ownerKey, "agents");
  const update = useUpdateConfig(scope, ownerKey, "agents");
  const remove = useRemoveConfig(scope, ownerKey, "agents");

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [model, setModel] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      {
        name: n,
        description: description.trim(),
        prompt,
        model: model.trim() || undefined,
        enabled: true,
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setPrompt("");
          setModel("");
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Agents"
      testId="agents-section"
      query={list}
      emptyText="No agents configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Agent name" />
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                aria-label="Agent description"
              />
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Prompt"
                aria-label="Agent prompt"
                rows={3}
                className={TEXTAREA_CLASS}
              />
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model (optional)"
                aria-label="Agent model"
              />
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add agent
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(a) => (
        <li key={a.id} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate">
            <span className="font-medium">{a.name}</span>
            {a.model ? <span className="ml-1 font-mono text-xs text-fg-muted">{a.model}</span> : null}
            {a.description ? (
              <span className="block truncate text-xs text-fg-muted">{a.description}</span>
            ) : null}
          </span>
          <EnableToggle
            enabled={a.enabled}
            disabled={!manage || update.isPending}
            label={`Toggle agent ${a.name}`}
            onChange={(enabled) => update.mutate({ id: a.id, patch: { enabled } })}
          />
          {manage ? (
            <DeleteButton
              label={`Delete agent ${a.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(a.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── Skills ──────────────────────────────────────────────────────────────────

export function SkillsSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "skills");
  const create = useCreateConfig(scope, ownerKey, "skills");
  const update = useUpdateConfig(scope, ownerKey, "skills");
  const remove = useRemoveConfig(scope, ownerKey, "skills");

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [agent, setAgent] = React.useState("");
  const [allowedTools, setAllowedTools] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const tools = splitCommas(allowedTools);
    create.mutate(
      {
        name: n,
        description: description.trim(),
        body,
        agent: agent.trim() || undefined,
        allowedTools: tools.length > 0 ? tools : undefined,
        enabled: true,
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setBody("");
          setAgent("");
          setAllowedTools("");
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Skills"
      testId="skills-section"
      query={list}
      emptyText="No skills configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Skill name" />
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                aria-label="Skill description"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Body"
                aria-label="Skill body"
                rows={3}
                className={TEXTAREA_CLASS}
              />
              <Input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="Agent (optional)"
                aria-label="Skill agent"
              />
              <Input
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                placeholder="Allowed tools (comma-separated)"
                aria-label="Skill allowed tools"
              />
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add skill
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(s) => (
        <li key={s.id} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate">
            <span className="font-medium">{s.name}</span>
            {s.agent ? <span className="ml-1 font-mono text-xs text-fg-muted">@{s.agent}</span> : null}
            {s.description ? (
              <span className="block truncate text-xs text-fg-muted">{s.description}</span>
            ) : null}
          </span>
          <EnableToggle
            enabled={s.enabled}
            disabled={!manage || update.isPending}
            label={`Toggle skill ${s.name}`}
            onChange={(enabled) => update.mutate({ id: s.id, patch: { enabled } })}
          />
          {manage ? (
            <DeleteButton
              label={`Delete skill ${s.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(s.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── MCP servers ───────────────────────────────────────────────────────────────

export function McpServersSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "mcp");
  const create = useCreateConfig(scope, ownerKey, "mcp");
  const update = useUpdateConfig(scope, ownerKey, "mcp");
  const remove = useRemoveConfig(scope, ownerKey, "mcp");

  const [name, setName] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [args, setArgs] = React.useState("");
  const [envKeys, setEnvKeys] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const c = command.trim();
    if (!n || !c) return;
    create.mutate(
      {
        name: n,
        command: c,
        args: splitList(args),
        envKeys: splitCommas(envKeys),
        enabled: true,
      },
      {
        onSuccess: () => {
          setName("");
          setCommand("");
          setArgs("");
          setEnvKeys("");
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="MCP servers"
      subtitle={
        <p className="-mt-1 mb-2 text-xs text-fg-muted">
          Model Context Protocol — external tool servers
        </p>
      }
      testId="mcp-section"
      query={list}
      emptyText="No MCP servers configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="MCP name" />
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="Command"
                aria-label="MCP command"
              />
              <Input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="Args (space or comma-separated)"
                aria-label="MCP args"
              />
              <Input
                value={envKeys}
                onChange={(e) => setEnvKeys(e.target.value)}
                placeholder="Env keys (comma-separated)"
                aria-label="MCP env keys"
              />
              <Button type="submit" disabled={!name.trim() || !command.trim() || create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add server
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(m) => (
        <li key={m.id} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate">
            <span className="font-medium">{m.name}</span>
            <span className="block truncate font-mono text-xs text-fg-muted">
              {m.command} {m.args.join(" ")}
            </span>
          </span>
          <EnableToggle
            enabled={m.enabled}
            disabled={!manage || update.isPending}
            label={`Toggle MCP server ${m.name}`}
            onChange={(enabled) => update.mutate({ id: m.id, patch: { enabled } })}
          />
          {manage ? (
            <DeleteButton
              label={`Delete MCP server ${m.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(m.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── Context docs (AGENTS.md-like) ─────────────────────────────────────────────

export function ContextSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "context");
  const create = useCreateConfig(scope, ownerKey, "context");
  const update = useUpdateConfig(scope, ownerKey, "context");
  const remove = useRemoveConfig(scope, ownerKey, "context");

  const [name, setName] = React.useState("");
  const [body, setBody] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      { name: n, body, enabled: true },
      {
        onSuccess: () => {
          setName("");
          setBody("");
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Context docs"
      testId="context-section"
      query={list}
      emptyText="No context documents configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Context name" />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Body (AGENTS.md-like instructions)"
                aria-label="Context body"
                rows={4}
                className={TEXTAREA_CLASS}
              />
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add document
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(d) => (
        <li key={d.id} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate font-medium">{d.name}</span>
          <EnableToggle
            enabled={d.enabled}
            disabled={!manage || update.isPending}
            label={`Toggle context ${d.name}`}
            onChange={(enabled) => update.mutate({ id: d.id, patch: { enabled } })}
          />
          {manage ? (
            <DeleteButton
              label={`Delete context ${d.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(d.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

const HOOK_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
];

export function HooksSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "hooks");
  const create = useCreateConfig(scope, ownerKey, "hooks");
  const update = useUpdateConfig(scope, ownerKey, "hooks");
  const remove = useRemoveConfig(scope, ownerKey, "hooks");

  const [name, setName] = React.useState("");
  const [event, setEvent] = React.useState<HookEvent>("PreToolUse");
  const [command, setCommand] = React.useState("");
  const [matcher, setMatcher] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const c = command.trim();
    if (!n || !c) return;
    create.mutate(
      {
        name: n,
        event,
        command: c,
        matcher: matcher.trim() || undefined,
        enabled: true,
      },
      {
        onSuccess: () => {
          setName("");
          setCommand("");
          setMatcher("");
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Hooks"
      testId="hooks-section"
      query={list}
      emptyText="No hooks configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Hook name" />
              <select
                value={event}
                onChange={(e) => setEvent(e.target.value as HookEvent)}
                aria-label="Hook event"
                className={`${SELECT_CLASS} w-full`}
              >
                {HOOK_EVENTS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="Command"
                aria-label="Hook command"
              />
              <Input
                value={matcher}
                onChange={(e) => setMatcher(e.target.value)}
                placeholder="Matcher (optional)"
                aria-label="Hook matcher"
              />
              <Button type="submit" disabled={!name.trim() || !command.trim() || create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add hook
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(h) => (
        <li key={h.id} className="flex items-center gap-2 py-2">
          <span className="flex-1 truncate">
            <span className="font-medium">{h.name}</span>
            <span className="ml-1 text-xs text-fg-muted">{h.event}</span>
            <span className="block truncate font-mono text-xs text-fg-muted">{h.command}</span>
          </span>
          <EnableToggle
            enabled={h.enabled}
            disabled={!manage || update.isPending}
            label={`Toggle hook ${h.name}`}
            onChange={(enabled) => update.mutate({ id: h.id, patch: { enabled } })}
          />
          {manage ? (
            <DeleteButton
              label={`Delete hook ${h.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(h.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── Env vars / secrets ─────────────────────────────────────────────────────────

export function EnvVarsSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const list = useConfigList(scope, ownerKey, "env");
  const create = useCreateConfig(scope, ownerKey, "env");
  const remove = useRemoveConfig(scope, ownerKey, "env");

  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [secret, setSecret] = React.useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    create.mutate(
      { key: k, value, secret },
      {
        onSuccess: () => {
          setKey("");
          setValue("");
          setSecret(false);
          toast("Saved");
        },
      },
    );
  };

  return (
    <ConfigSection
      title="Environment variables"
      testId="env-section"
      query={list}
      emptyText="No environment variables configured."
      form={
        <>
          {manage ? (
            <form onSubmit={submit} className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="KEY" aria-label="Env key" />
              <Input
                type={secret ? "password" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Value"
                aria-label="Env value"
              />
              <label className="flex shrink-0 items-center gap-1 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  checked={secret}
                  onChange={(e) => setSecret(e.target.checked)}
                  aria-label="Secret"
                />
                secret
              </label>
              <Button type="submit" disabled={!key.trim() || create.isPending} className="shrink-0">
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Add variable
              </Button>
            </form>
          ) : null}
          {create.isError ? (
            <p className="mb-2 text-sm text-danger">{(create.error as Error).message}</p>
          ) : null}
        </>
      }
      renderItem={(v) => (
        <li key={v.id} className="flex items-center gap-2 py-1.5">
          <span className="w-40 truncate font-mono text-xs">{v.key}</span>
          <span className="flex-1 truncate font-mono text-xs text-fg-muted">
            {/* Never display stored secret values — show a mask instead. */}
            {v.secret ? (v.hasValue ? "••••••••" : "—") : v.value}
          </span>
          {v.secret ? (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              secret
            </Badge>
          ) : null}
          {manage ? (
            <DeleteButton
              label={`Delete env ${v.key}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(v.id, { onSuccess: () => toast("Removed") })}
            />
          ) : null}
        </li>
      )}
    />
  );
}

// ── Model params (singleton per scope) ─────────────────────────────────────────

const EFFORTS: ModelParams["effort"][] = ["", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_MODEL_PARAMS: ModelParams = {
  model: "",
  effort: "",
  maxSteps: 0,
  contextBudget: 0,
  planMode: false,
};

export function ModelParamsSection({ scope, ownerKey, manage }: SectionProps) {
  const toast = useToast();
  const query = useModelParams(scope, ownerKey, { retry: false });
  const put = usePutModelParams(scope, ownerKey);

  const [form, setForm] = React.useState<ModelParams>(DEFAULT_MODEL_PARAMS);

  // Seed the form once the server params load.
  React.useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    put.mutate(form, { onSuccess: () => toast("Saved") });
  };

  return (
    <Card className="mb-4 p-4" data-testid="model-params-section">
      <h2 className="mb-2 text-sm font-medium">Model parameters</h2>

      {query.isLoading ? (
        <Loading />
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <label className="block text-xs text-fg-muted">
            Model
            <Input
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="Model"
              aria-label="Model"
              disabled={!manage}
              className="mt-1"
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Effort
            <select
              value={form.effort}
              onChange={(e) => setForm((f) => ({ ...f, effort: e.target.value as ModelParams["effort"] }))}
              aria-label="Effort"
              disabled={!manage}
              className={`${SELECT_CLASS} mt-1 w-full`}
            >
              {EFFORTS.map((ef) => (
                <option key={ef} value={ef}>
                  {ef === "" ? "(default)" : ef}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-fg-muted">
            Max steps
            <Input
              type="number"
              min={0}
              value={String(form.maxSteps)}
              onChange={(e) => setForm((f) => ({ ...f, maxSteps: Number(e.target.value) || 0 }))}
              aria-label="Max steps"
              disabled={!manage}
              className="mt-1"
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Context budget
            <Input
              type="number"
              min={0}
              value={String(form.contextBudget)}
              onChange={(e) => setForm((f) => ({ ...f, contextBudget: Number(e.target.value) || 0 }))}
              aria-label="Context budget"
              disabled={!manage}
              className="mt-1"
            />
          </label>
          <label
            className="flex items-center gap-1 text-sm text-fg-muted"
            title="Agent drafts a plan before editing code"
          >
            <input
              type="checkbox"
              checked={form.planMode}
              onChange={(e) => setForm((f) => ({ ...f, planMode: e.target.checked }))}
              aria-label="Plan mode"
              disabled={!manage}
            />
            Plan mode
          </label>
          {manage ? (
            <Button type="submit" disabled={put.isPending}>
              {put.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              Save
            </Button>
          ) : null}
          {put.isError ? (
            <p className="text-sm text-danger">{(put.error as Error).message}</p>
          ) : null}
        </form>
      )}
    </Card>
  );
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

/** All config sections in the prescribed order (Model → Context → … → Env). */
export function ConfigSections(props: SectionProps) {
  return (
    <>
      <ModelParamsSection {...props} />
      <ContextSection {...props} />
      <AgentsSection {...props} />
      <SkillsSection {...props} />
      <McpServersSection {...props} />
      <HooksSection {...props} />
      <EnvVarsSection {...props} />
    </>
  );
}
