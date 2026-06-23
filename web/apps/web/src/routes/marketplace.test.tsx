import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type {
  Me,
  MarketplacePlugin,
  PluginManifest,
  PluginVersion,
  PluginInstall,
} from "@carrier/contract";

// ── Mock the api client (units-under-test talk only to this module). ──────────
vi.mock("../api/client", () => ({
  api: {
    marketplace: {
      search: vi.fn(),
      versions: vi.fn(),
      version: vi.fn(),
      listInstalls: vi.fn(),
      install: vi.fn(),
      updateInstall: vi.fn(),
      uninstall: vi.fn(),
    },
  },
}));

// ── Mock react-router hooks that need a data router. ──────────────────────────
const navigateMock = vi.fn();
let params: Record<string, string> = {};
let rootData: Me | undefined;
vi.mock("react-router", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useParams: () => params,
    useNavigate: () => navigateMock,
    useRouteLoaderData: () => rootData,
  };
});

import { api } from "../api/client";
import {
  MarketplacePage,
  PluginDetailPage,
  InstalledPluginsSection,
} from "./marketplace";

const ownerMe: Me = {
  account: { id: "a1", login: "octo", name: "Octo", avatarUrl: "https://x/y.png" },
  orgs: [{ id: "o1", kind: "org", slug: "acme", name: "Acme", role: "owner" }],
};

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "linter",
    version: "1.0.0",
    publisher: "acme-labs",
    api: "carrier.plugin/v1",
    description: "Lints your code",
    seams: ["tool_before", "tool_after"],
    capabilities: {
      network: ["api.example.com"],
      secrets: ["OPENAI_KEY"],
      kv: true,
      permissionsAllow: true,
    },
    artifacts: {},
    ...over,
  };
}

function version(over: Partial<PluginVersion> = {}): PluginVersion {
  return {
    name: "linter",
    version: "1.0.0",
    manifestDigest: "sha256-abc",
    manifest: manifest(),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function renderPage(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
  params = {};
  rootData = ownerMe;
});

// ── Browse / search (Req 4) ───────────────────────────────────────────────────
describe("MarketplacePage", () => {
  it("renders listings with a verified badge", async () => {
    params = { org: "acme" };
    const plugins: MarketplacePlugin[] = [
      {
        name: "linter",
        publisher: "acme-labs",
        verified: true,
        description: "Lints code",
        latestVersion: "1.0.0",
      },
      {
        name: "sketchy",
        publisher: "rando",
        verified: false,
        description: "Unverified",
        latestVersion: "0.1.0",
      },
    ];
    (api.marketplace.search as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);

    renderPage(<MarketplacePage />);
    const list = await screen.findByTestId("marketplace-list");
    expect(within(list).getByText("linter")).toBeInTheDocument();
    expect(within(list).getByText("sketchy")).toBeInTheDocument();
    // Exactly one verified badge — only the verified plugin shows it.
    expect(within(list).getAllByText("verified")).toHaveLength(1);
  });
});

// ── Detail capabilities (Req 4/5) ─────────────────────────────────────────────
describe("PluginDetailPage", () => {
  it("shows requested capabilities and seams", async () => {
    params = { org: "acme", name: "linter" };
    (api.marketplace.versions as ReturnType<typeof vi.fn>).mockResolvedValue([version()]);
    (api.marketplace.version as ReturnType<typeof vi.fn>).mockResolvedValue({
      manifest: manifest(),
      manifestDigest: "sha256-abc",
      signature: "sig",
      wasmDigest: "sha256-wasm",
    });

    renderPage(<PluginDetailPage />);
    const caps = await screen.findByTestId("capabilities-section");
    expect(within(caps).getByText("api.example.com")).toBeInTheDocument();
    expect(within(caps).getByText("OPENAI_KEY")).toBeInTheDocument();
    const seams = within(caps).getByTestId("seams-list");
    expect(within(seams).getByText("tool_before")).toBeInTheDocument();
    expect(within(seams).getByText("tool_after")).toBeInTheDocument();
  });

  it("requires ticking permissions.allow before it is granted", async () => {
    params = { org: "acme", name: "linter" };
    (api.marketplace.versions as ReturnType<typeof vi.fn>).mockResolvedValue([version()]);
    (api.marketplace.version as ReturnType<typeof vi.fn>).mockResolvedValue({
      manifest: manifest(),
      manifestDigest: "sha256-abc",
      signature: "sig",
      wasmDigest: "sha256-wasm",
    });
    (api.marketplace.install as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "i1",
      scope: "org",
      name: "linter",
      version: "1.0.0",
      manifestDigest: "sha256-abc",
      grantedCaps: [],
      allowPermissions: false,
      enabled: true,
    } satisfies PluginInstall);

    renderPage(<PluginDetailPage />);
    fireEvent.click(await screen.findByTestId("open-install"));
    const dialog = await screen.findByTestId("install-dialog");

    // Confirm WITHOUT ticking permissions.allow → allowPermissions:false, but
    // the default-checked network/secret/kv caps are granted.
    fireEvent.click(within(dialog).getByTestId("confirm-install"));
    await waitFor(() =>
      expect(api.marketplace.install).toHaveBeenCalledWith("org", "acme", {
        name: "linter",
        version: "1.0.0",
        grantedCaps: ["network:api.example.com", "secret:OPENAI_KEY", "kv"],
        allowPermissions: false,
      }),
    );

    // Now tick permissions.allow and re-confirm → allowPermissions:true.
    (api.marketplace.install as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(within(dialog).getByLabelText("Grant permissions.allow"));
    fireEvent.click(within(dialog).getByTestId("confirm-install"));
    await waitFor(() =>
      expect(api.marketplace.install).toHaveBeenCalledWith(
        "org",
        "acme",
        expect.objectContaining({ allowPermissions: true }),
      ),
    );
  });
});

// ── Installed-plugins management (Req 5) ──────────────────────────────────────
describe("InstalledPluginsSection", () => {
  it("toggling enable calls updateInstall with the enabled patch", async () => {
    const installed: PluginInstall = {
      id: "i1",
      scope: "org",
      name: "linter",
      version: "1.0.0",
      manifestDigest: "sha256-abc",
      grantedCaps: ["kv"],
      allowPermissions: false,
      enabled: true,
    };
    (api.marketplace.listInstalls as ReturnType<typeof vi.fn>).mockResolvedValue([installed]);
    (api.marketplace.updateInstall as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...installed,
      enabled: false,
    });

    renderPage(<InstalledPluginsSection scope="org" ownerKey="acme" manage />);
    const section = await screen.findByTestId("installed-plugins-section");
    await within(section).findByText("linter");

    fireEvent.click(within(section).getByLabelText("Toggle plugin linter"));
    await waitFor(() =>
      expect(api.marketplace.updateInstall).toHaveBeenCalledWith("org", "acme", "i1", {
        enabled: false,
      }),
    );
  });
});
