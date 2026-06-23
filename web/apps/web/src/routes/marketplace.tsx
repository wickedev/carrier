import * as React from "react";
import { Link, useParams, useNavigate, useRouteLoaderData } from "react-router";
import type {
  Me,
  Role,
  ConfigScope,
  MarketplacePlugin,
  PluginManifest,
  PluginVersion,
  SeamKind,
} from "@carrier/contract";
import { Button } from "@carrier/ui";
import {
  Search,
  BadgeCheck,
  Package,
  Globe,
  KeyRound,
  Database,
  ShieldAlert,
  Plug,
  Trash2,
  Loader2,
} from "lucide-react";
import { Card, Badge, Input, Loading, ErrorState, EmptyState } from "../components/primitives";
import {
  useMarketplaceSearch,
  usePluginVersions,
  usePluginVersion,
  useInstalledPlugins,
  useInstallPlugin,
  useUpdateInstall,
  useUninstall,
} from "../api/queries";

/** Roles that may install / manage plugins (mirrors config mutations). */
function canManage(role?: Role): boolean {
  return role === "owner" || role === "admin";
}

/** A small "verified publisher" badge (Req 4 — verified publishers only). */
function VerifiedBadge() {
  return (
    <Badge className="gap-1 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
      <BadgeCheck className="h-3 w-3" aria-hidden /> verified
    </Badge>
  );
}

// ── Browse / search (Req 4) ───────────────────────────────────────────────────

/** /:org/marketplace — search box + grid of marketplace plugin cards. */
export function MarketplacePage() {
  const { org = "" } = useParams();
  const [query, setQuery] = React.useState("");
  const search = useMarketplaceSearch(query);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-neutral-500">
        <Link to={`/${org}`} className="hover:underline">
          {org}
        </Link>{" "}
        / <span className="text-neutral-800 dark:text-neutral-100">Marketplace</span>
      </div>
      <h1 className="mb-4 text-lg font-semibold">Plugin marketplace</h1>

      <div className="relative mb-6">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search plugins…"
          aria-label="Search plugins"
          className="pl-9"
        />
      </div>

      {search.isLoading ? (
        <Loading />
      ) : search.isError ? (
        <ErrorState message={(search.error as Error).message} onRetry={() => search.refetch()} />
      ) : search.data && search.data.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="marketplace-list">
          {search.data.map((p) => (
            <li key={p.name}>
              <PluginCard org={org} plugin={p} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No plugins found"
          description="Try a different search, or check back later for new plugins."
        />
      )}
    </div>
  );
}

function PluginCard({ org, plugin }: { org: string; plugin: MarketplacePlugin }) {
  return (
    <Link to={`/${org}/marketplace/${encodeURIComponent(plugin.name)}`}>
      <Card
        className="flex h-full flex-col gap-1 p-3 transition-colors hover:border-neutral-300 dark:hover:border-neutral-700"
        data-testid="plugin-card"
      >
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-blue-500" aria-hidden />
          <span className="truncate font-medium">{plugin.name}</span>
          {plugin.verified ? <VerifiedBadge /> : null}
        </div>
        <p className="text-xs text-neutral-500">
          {plugin.publisher} · v{plugin.latestVersion}
        </p>
        {plugin.description ? (
          <p className="line-clamp-2 text-sm text-neutral-600 dark:text-neutral-300">
            {plugin.description}
          </p>
        ) : null}
      </Card>
    </Link>
  );
}

// ── Detail (Req 4/5) ──────────────────────────────────────────────────────────

/** /:org/marketplace/:name — versions, capabilities, seams + the install flow. */
export function PluginDetailPage() {
  const { org = "", name = "" } = useParams();
  const me = useRouteLoaderData("root") as Me | undefined;
  const currentOrg = me?.orgs.find((o) => o.slug === org);
  const manage = canManage(currentOrg?.role);

  const versions = usePluginVersions(name);
  const [selected, setSelected] = React.useState<string | null>(null);

  // Default to the newest (first) published version once loaded.
  const versionList = versions.data;
  React.useEffect(() => {
    if (versionList && versionList.length > 0 && !selected) {
      setSelected(versionList[0]!.version);
    }
  }, [versionList, selected]);

  const detail = usePluginVersion(name, selected);
  const [installing, setInstalling] = React.useState(false);

  const current = versionList?.find((v) => v.version === selected);
  const manifest = detail.data?.manifest ?? current?.manifest;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 text-sm text-neutral-500">
        <Link to={`/${org}/marketplace`} className="hover:underline">
          Marketplace
        </Link>{" "}
        / <span className="text-neutral-800 dark:text-neutral-100">{name}</span>
      </div>

      {versions.isLoading ? (
        <Loading />
      ) : versions.isError ? (
        <ErrorState message={(versions.error as Error).message} onRetry={() => versions.refetch()} />
      ) : !versionList || versionList.length === 0 ? (
        <EmptyState title="No versions" description="This plugin has no published versions." />
      ) : (
        <>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                {name}
              </h1>
              <p className="text-sm text-neutral-500">
                {manifest?.publisher}
                {manifest?.description ? ` — ${manifest.description}` : ""}
              </p>
            </div>
            <Button
              onClick={() => setInstalling(true)}
              disabled={!manage || !manifest || installing}
              data-testid="open-install"
            >
              <Plug className="h-4 w-4" aria-hidden /> Install
            </Button>
          </div>
          {!manage ? (
            <p className="mb-4 text-sm text-neutral-500">
              Only owners and admins can install plugins.
            </p>
          ) : null}

          <VersionPicker versions={versionList} selected={selected} onSelect={setSelected} />

          {manifest ? (
            <CapabilitiesCard manifest={manifest} />
          ) : detail.isLoading ? (
            <Loading />
          ) : null}

          {installing && manifest && current ? (
            <InstallConsentDialog
              org={org}
              orgScope={{ scope: "org", ownerKey: org }}
              manifest={manifest}
              version={current.version}
              onClose={() => setInstalling(false)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function VersionPicker({
  versions,
  selected,
  onSelect,
}: {
  versions: PluginVersion[];
  selected: string | null;
  onSelect: (v: string) => void;
}) {
  return (
    <Card className="mb-4 p-4" data-testid="versions-section">
      <h2 className="mb-2 text-sm font-medium">Versions</h2>
      <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {versions.map((v) => (
          <li key={v.version} className="flex items-center gap-2 py-1.5">
            <label className="flex flex-1 items-center gap-2">
              <input
                type="radio"
                name="plugin-version"
                checked={selected === v.version}
                onChange={() => onSelect(v.version)}
                aria-label={`Select version ${v.version}`}
              />
              <span className="font-mono">{v.version}</span>
            </label>
            <span className="truncate font-mono text-xs text-neutral-500">{v.manifestDigest}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Capability tokens ─────────────────────────────────────────────────────────
//
// grantedCaps is a flat string[] on the install record. We encode each granted
// capability as a stable token so the runtime can match the manifest's request
// against the operator's approval; `permissions.allow` is carried separately as
// the `allowPermissions` boolean.

export function networkCap(host: string): string {
  return `network:${host}`;
}
export function secretCap(key: string): string {
  return `secret:${key}`;
}
export const KV_CAP = "kv";

/** Read-only display of every capability + seam a manifest requests. */
function CapabilitiesCard({ manifest }: { manifest: PluginManifest }) {
  const caps = manifest.capabilities;
  const allow = manifest.declarative?.permissions ?? [];
  return (
    <Card className="mb-4 p-4" data-testid="capabilities-section">
      <h2 className="mb-2 text-sm font-medium">Requested capabilities</h2>
      <dl className="space-y-3 text-sm">
        <CapabilityRow
          icon={<Globe className="h-4 w-4" aria-hidden />}
          label="Network hosts"
          items={caps.network}
          empty="No outbound network access"
        />
        <CapabilityRow
          icon={<KeyRound className="h-4 w-4" aria-hidden />}
          label="Secret keys"
          items={caps.secrets}
          empty="No secrets requested"
        />
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-neutral-500" aria-hidden />
          <span className="font-medium">KV store</span>
          <span className="text-neutral-500">{caps.kv ? "requested" : "not requested"}</span>
        </div>
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden />
          <span className="font-medium">permissions.allow</span>
          <span className="text-neutral-500">
            {caps.permissionsAllow ? "opt-in requested" : "not requested"}
          </span>
        </div>
        {allow.length > 0 ? (
          <CapabilityRow
            icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
            label="Permission rules"
            items={allow.map((r) => `${r.effect} ${r.action} ${r.pattern}`)}
            empty=""
          />
        ) : null}
      </dl>

      <h2 className="mb-2 mt-4 text-sm font-medium">Seams</h2>
      {manifest.seams.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="seams-list">
          {manifest.seams.map((s: SeamKind) => (
            <Badge key={s} className="bg-neutral-100 font-mono dark:bg-neutral-800">
              {s}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No seams implemented.</p>
      )}
    </Card>
  );
}

function CapabilityRow({
  icon,
  label,
  items,
  empty,
}: {
  icon: React.ReactNode;
  label: string;
  items: string[];
  empty: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 font-medium text-neutral-700 dark:text-neutral-200">
        <span className="text-neutral-500">{icon}</span>
        {label}
      </dt>
      <dd className="ml-6 mt-1">
        {items.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {items.map((it) => (
              <li key={it}>
                <Badge className="bg-neutral-100 font-mono dark:bg-neutral-800">{it}</Badge>
              </li>
            ))}
          </ul>
        ) : empty ? (
          <span className="text-neutral-500">{empty}</span>
        ) : null}
      </dd>
    </div>
  );
}

// ── Install consent flow (Req 5) ──────────────────────────────────────────────

interface ScopeRef {
  scope: ConfigScope;
  ownerKey: string;
}

/**
 * The consent modal: surfaces EVERY requested capability as a tick-box the
 * operator must approve, a distinct opt-in for `permissions.allow`, and a scope
 * selector (org vs project, when a project context is available). On confirm we
 * install the pinned version with the approved capabilities as `grantedCaps`.
 */
function InstallConsentDialog({
  org,
  orgScope,
  projectScope,
  manifest,
  version,
  onClose,
}: {
  org: string;
  orgScope: ScopeRef;
  projectScope?: ScopeRef;
  manifest: PluginManifest;
  version: string;
  onClose: () => void;
}) {
  const caps = manifest.capabilities;
  const navigate = useNavigate();

  const [scope, setScope] = React.useState<ConfigScope>("org");
  const target = scope === "project" && projectScope ? projectScope : orgScope;
  const install = useInstallPlugin(target.scope, target.ownerKey);

  // Per-capability approval state — network hosts, secret keys, and kv default
  // to checked (the operator can deselect); permissions.allow defaults to OFF
  // and must be explicitly ticked to be granted.
  const [network, setNetwork] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(caps.network.map((h) => [h, true])),
  );
  const [secrets, setSecrets] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(caps.secrets.map((k) => [k, true])),
  );
  const [kv, setKv] = React.useState(caps.kv);
  const [allowPermissions, setAllowPermissions] = React.useState(false);

  const submit = () => {
    const grantedCaps: string[] = [];
    for (const h of caps.network) if (network[h]) grantedCaps.push(networkCap(h));
    for (const k of caps.secrets) if (secrets[k]) grantedCaps.push(secretCap(k));
    if (caps.kv && kv) grantedCaps.push(KV_CAP);

    install.mutate(
      {
        name: manifest.name,
        version,
        grantedCaps,
        allowPermissions: caps.permissionsAllow ? allowPermissions : false,
      },
      { onSuccess: () => navigate(`/${org}/marketplace`) },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Install plugin"
      data-testid="install-dialog"
    >
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto p-5">
        <h2 className="mb-1 text-base font-semibold">Install {manifest.name}</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Pinned version <span className="font-mono">v{version}</span>. Approve the capabilities
          below — anything you leave unchecked will be denied at runtime.
        </p>

        {projectScope ? (
          <label className="mb-4 block text-xs text-neutral-500">
            Install scope
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ConfigScope)}
              aria-label="Install scope"
              className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            >
              <option value="org">Organization ({orgScope.ownerKey})</option>
              <option value="project">This project</option>
            </select>
          </label>
        ) : null}

        <div className="space-y-4">
          {caps.network.length > 0 ? (
            <fieldset>
              <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
                <Globe className="h-4 w-4 text-neutral-500" aria-hidden /> Network hosts
              </legend>
              {caps.network.map((h) => (
                <label key={h} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={!!network[h]}
                    onChange={(e) => setNetwork((s) => ({ ...s, [h]: e.target.checked }))}
                    aria-label={`Grant network ${h}`}
                  />
                  <span className="font-mono">{h}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {caps.secrets.length > 0 ? (
            <fieldset>
              <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4 text-neutral-500" aria-hidden /> Secret keys
              </legend>
              {caps.secrets.map((k) => (
                <label key={k} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={!!secrets[k]}
                    onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.checked }))}
                    aria-label={`Grant secret ${k}`}
                  />
                  <span className="font-mono">{k}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {caps.kv ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kv}
                onChange={(e) => setKv(e.target.checked)}
                aria-label="Grant kv store"
              />
              <Database className="h-4 w-4 text-neutral-500" aria-hidden />
              KV store access
            </label>
          ) : null}

          {caps.permissionsAllow ? (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-900 dark:bg-amber-900/20">
              <input
                type="checkbox"
                checked={allowPermissions}
                onChange={(e) => setAllowPermissions(e.target.checked)}
                aria-label="Grant permissions.allow"
                className="mt-0.5"
              />
              <span>
                <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="h-4 w-4" aria-hidden /> Honor permissions.allow
                </span>
                <span className="text-neutral-600 dark:text-neutral-300">
                  Lets this plugin's <span className="font-mono">permission_ask</span> grant an
                  "allow" decision. Off by default — only tick if you trust it.
                </span>
              </span>
            </label>
          ) : null}
        </div>

        {install.isError ? (
          <p className="mt-3 text-sm text-red-500">{(install.error as Error).message}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={install.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={install.isPending} data-testid="confirm-install">
            {install.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Install v{version}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Installed-plugins management section (Req 5) ───────────────────────────────

/**
 * A settings section listing installed plugins at a given scope, each with an
 * enable/disable toggle, the pinned version, and an uninstall control. Mirrors
 * the config-sections list pattern; manager-gated.
 */
export function InstalledPluginsSection({
  scope,
  ownerKey,
  manage,
}: {
  scope: ConfigScope;
  ownerKey: string;
  manage: boolean;
}) {
  const list = useInstalledPlugins(scope, ownerKey);
  const update = useUpdateInstall(scope, ownerKey);
  const uninstall = useUninstall(scope, ownerKey);

  return (
    <Card className="mb-4 p-4" data-testid="installed-plugins-section">
      <h2 className="mb-2 text-sm font-medium">Installed plugins</h2>

      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : list.data && list.data.length > 0 ? (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {list.data.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <span className="flex-1 truncate">
                <span className="font-medium">{p.name}</span>
                <span className="ml-1 font-mono text-xs text-neutral-500">v{p.version}</span>
                {p.allowPermissions ? (
                  <Badge className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    permissions.allow
                  </Badge>
                ) : null}
              </span>
              <label className="flex items-center gap-1 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={!manage || update.isPending}
                  aria-label={`Toggle plugin ${p.name}`}
                  onChange={(e) => update.mutate({ id: p.id, patch: { enabled: e.target.checked } })}
                />
                {p.enabled ? "on" : "off"}
              </label>
              {manage ? (
                <button
                  type="button"
                  aria-label={`Uninstall ${p.name}`}
                  disabled={uninstall.isPending}
                  onClick={() => uninstall.mutate(p.id)}
                  className="text-neutral-400 hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">No plugins installed.</p>
      )}
    </Card>
  );
}
