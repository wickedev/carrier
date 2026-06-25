import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

// ── Mock the api client (unit-under-test talks only to this module). ──────────
vi.mock("../api/client", () => ({
  api: {
    projects: vi.fn(),
    createProject: vi.fn(),
    bindRepo: vi.fn(),
    installations: vi.fn(),
  },
}));

vi.mock("react-router", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ org: "acme" }) };
});

import { api } from "../api/client";
import { OrgPage } from "./org";

const mockApi = api as unknown as {
  projects: ReturnType<typeof vi.fn>;
  createProject: ReturnType<typeof vi.fn>;
  bindRepo: ReturnType<typeof vi.fn>;
  installations: ReturnType<typeof vi.fn>;
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OrgPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.projects.mockResolvedValue([]);
  mockApi.installations.mockResolvedValue([
    {
      installationId: 42,
      accountLogin: "acme",
      repos: [{ fullName: "acme/web", defaultBranch: "main", private: true }],
    },
  ]);
  mockApi.createProject.mockResolvedValue({ id: "p1", name: "demo", repo: null, archived: false });
  mockApi.bindRepo.mockResolvedValue({ id: "p1", name: "demo" });
});

describe("OrgPage new-project modal", () => {
  it("opens the dialog from the New project button", async () => {
    renderPage();
    expect(screen.queryByTestId("new-project-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("new-project-button"));
    expect(await screen.findByTestId("new-project-dialog")).toBeInTheDocument();
  });

  it("creates an unbound project without binding a repo", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-project-button"));
    await screen.findByTestId("new-project-dialog");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(mockApi.createProject).toHaveBeenCalledWith("acme", "demo"));
    expect(mockApi.bindRepo).not.toHaveBeenCalled();
  });

  it("binds the selected repo with its default branch after creation", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-project-button"));
    await screen.findByTestId("new-project-dialog");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "demo" } });
    // Pick the installation, then the repo (both optional selects).
    fireEvent.change(await screen.findByLabelText("GitHub installation"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/web" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(mockApi.createProject).toHaveBeenCalledWith("acme", "demo"));
    await waitFor(() =>
      expect(mockApi.bindRepo).toHaveBeenCalledWith("p1", {
        installationId: 42,
        repoFullName: "acme/web",
        defaultBranch: "main",
      }),
    );
  });
});
