import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { Me, Project, PermissionRule, Usage } from "@carrier/contract";

// ── Mock the api client (the unit-under-test talks only to this module). ──────
vi.mock("../api/client", () => ({
  api: {
    permissions: vi.fn(),
    addPermission: vi.fn(),
    deletePermission: vi.fn(),
    members: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    installations: vi.fn(),
    project: vi.fn(),
    bindRepo: vi.fn(),
    unbindRepo: vi.fn(),
    archiveProject: vi.fn(),
    projectUsage: vi.fn(),
    config: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getModel: vi.fn(),
      putModel: vi.fn(),
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
import { OrgSettingsPage, ProjectSettingsPage } from "./settings";

const ownerMe: Me = {
  account: { id: "a1", login: "octo", name: "Octo", avatarUrl: "https://x/y.png" },
  orgs: [{ id: "o1", kind: "org", slug: "acme", name: "Acme", role: "owner" }],
};

const project: Project = {
  id: "p1",
  orgId: "o1",
  slug: "web",
  name: "Web",
  archived: false,
  repo: null,
  createdAt: new Date().toISOString(),
};

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
  // sensible defaults
  (api.installations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.members as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.permissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.project as ReturnType<typeof vi.fn>).mockResolvedValue(project);
  (api.projectUsage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no usage"));
  // Config sections rendered by both settings pages — empty defaults.
  (api.config.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.config.getModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no model"));
});

// ── Members (Req 21) ──────────────────────────────────────────────────────────
describe("OrgSettingsPage — member management", () => {
  it("adds a member via the form, calling the api with login + role", async () => {
    params = { org: "acme" };
    (api.members as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: "a1", login: "octo", role: "owner" },
    ]);
    (api.addMember as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: "a2",
      login: "newbie",
      role: "member",
    });

    renderPage(<OrgSettingsPage />);
    const section = await screen.findByTestId("members-section");
    await within(section).findByText("octo");

    fireEvent.change(within(section).getByLabelText("Member login"), {
      target: { value: "newbie" },
    });
    fireEvent.change(within(section).getByLabelText("Member role"), {
      target: { value: "admin" },
    });
    fireEvent.click(within(section).getByRole("button", { name: /Add/i }));

    await waitFor(() =>
      expect(api.addMember).toHaveBeenCalledWith("acme", { login: "newbie", role: "admin" }),
    );
  });

  it("removes a member via the trash control", async () => {
    params = { org: "acme" };
    (api.members as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: "a2", login: "bob", role: "member" },
    ]);
    (api.removeMember as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    renderPage(<OrgSettingsPage />);
    await screen.findByText("bob");

    fireEvent.click(screen.getByRole("button", { name: "Remove bob" }));
    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("acme", "a2"));
  });

  it("hides management controls for non-managers", async () => {
    params = { org: "acme" };
    rootData = {
      ...ownerMe,
      orgs: [{ ...ownerMe.orgs[0]!, role: "member" }],
    };
    (api.members as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: "a2", login: "bob", role: "member" },
    ]);
    renderPage(<OrgSettingsPage />);
    await screen.findByText("bob");
    expect(screen.queryByLabelText("Member login")).not.toBeInTheDocument();
  });
});

// ── Permission editor (Req 18) ────────────────────────────────────────────────
describe("ProjectSettingsPage — permission editor", () => {
  const rule: PermissionRule = { id: "r1", action: "write", pattern: "**/*.ts", effect: "ask" };

  it("adds a permission rule via the form", async () => {
    params = { org: "acme", project: "p1" };
    (api.permissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (api.addPermission as ReturnType<typeof vi.fn>).mockResolvedValue(rule);

    renderPage(<ProjectSettingsPage />);
    const section = await screen.findByTestId("permissions-section");

    fireEvent.change(within(section).getByLabelText("Resource pattern"), {
      target: { value: "src/**" },
    });
    fireEvent.change(within(section).getByLabelText("Rule effect"), { target: { value: "deny" } });
    fireEvent.click(within(section).getByRole("button", { name: /Add/i }));

    await waitFor(() =>
      expect(api.addPermission).toHaveBeenCalledWith("p1", {
        action: "write",
        pattern: "src/**",
        effect: "deny",
      }),
    );
  });

  it("deletes a permission rule via the trash control", async () => {
    params = { org: "acme", project: "p1" };
    (api.permissions as ReturnType<typeof vi.fn>).mockResolvedValue([rule]);
    (api.deletePermission as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    renderPage(<ProjectSettingsPage />);
    await screen.findByText("**/*.ts");

    fireEvent.click(screen.getByRole("button", { name: /Delete rule write/ }));
    await waitFor(() => expect(api.deletePermission).toHaveBeenCalledWith("p1", "r1"));
  });
});

// ── Repo binding (Req 21) ─────────────────────────────────────────────────────
describe("ProjectSettingsPage — repo binding", () => {
  it("binds a repo from the chosen installation + repo + branch", async () => {
    params = { org: "acme", project: "p1" };
    (api.installations as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        installationId: 42,
        accountLogin: "acme",
        repos: [{ fullName: "acme/web", defaultBranch: "main", private: true }],
      },
    ]);
    (api.bindRepo as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...project,
      repo: { repoFullName: "acme/web", defaultBranch: "main", installationId: 42 },
    });

    renderPage(<ProjectSettingsPage />);
    const section = await screen.findByTestId("repo-binding-section");

    fireEvent.change(await within(section).findByLabelText("Installation"), {
      target: { value: "42" },
    });
    fireEvent.change(within(section).getByLabelText("Repository"), {
      target: { value: "acme/web" },
    });
    await waitFor(() =>
      expect((within(section).getByLabelText("Default branch") as HTMLInputElement).value).toBe(
        "main",
      ),
    );
    fireEvent.click(within(section).getByRole("button", { name: /Bind repository/i }));

    await waitFor(() =>
      expect(api.bindRepo).toHaveBeenCalledWith("p1", {
        installationId: 42,
        repoFullName: "acme/web",
        defaultBranch: "main",
      }),
    );
  });

  it("archives the project from the danger zone after confirm", async () => {
    params = { org: "acme", project: "p1" };
    (api.archiveProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    renderPage(<ProjectSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));

    await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/acme"));
  });
});

// ── Project usage rollup (Req 20) ─────────────────────────────────────────────
describe("ProjectSettingsPage — usage rollup", () => {
  it("renders the usage rollup when available", async () => {
    params = { org: "acme", project: "p1" };
    const usage: Usage = {
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0421,
    };
    (api.projectUsage as ReturnType<typeof vi.fn>).mockResolvedValue(usage);

    renderPage(<ProjectSettingsPage />);
    const section = await screen.findByTestId("project-usage-section");
    expect(await within(section).findByText("$0.0421")).toBeInTheDocument();
    expect(within(section).getByText("2.0k")).toBeInTheDocument();
  });
});
