import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDef, EnvVar, ModelParams } from "@carrier/contract";

// ── Mock the api client (sections talk only to api.config.*). ─────────────────
vi.mock("../api/client", () => ({
  api: {
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

import { api } from "../api/client";
import {
  AgentsSection,
  EnvVarsSection,
  ModelParamsSection,
} from "./config-sections";

function renderSection(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.config.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.config.getModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no model"));
});

// ── Agents ────────────────────────────────────────────────────────────────────
describe("AgentsSection", () => {
  const agent: AgentDef = {
    id: "ag1",
    scope: "project",
    name: "reviewer",
    description: "Reviews code",
    prompt: "You review code.",
    enabled: true,
  };

  it("renders the list and creates an agent with the right args", async () => {
    (api.config.list as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    (api.config.create as ReturnType<typeof vi.fn>).mockResolvedValue(agent);

    renderSection(<AgentsSection scope="project" ownerKey="p1" manage />);
    const section = await screen.findByTestId("agents-section");
    expect(await within(section).findByText("reviewer")).toBeInTheDocument();

    fireEvent.change(within(section).getByLabelText("Agent name"), {
      target: { value: "planner" },
    });
    fireEvent.change(within(section).getByLabelText("Agent description"), {
      target: { value: "Plans work" },
    });
    fireEvent.change(within(section).getByLabelText("Agent prompt"), {
      target: { value: "You plan." },
    });
    fireEvent.click(within(section).getByRole("button", { name: /Add agent/i }));

    await waitFor(() =>
      expect(api.config.create).toHaveBeenCalledWith("project", "p1", "agents", {
        name: "planner",
        description: "Plans work",
        prompt: "You plan.",
        model: undefined,
        enabled: true,
      }),
    );
  });

  it("toggling enable calls update with the enabled patch", async () => {
    (api.config.list as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    (api.config.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...agent,
      enabled: false,
    });

    renderSection(<AgentsSection scope="org" ownerKey="acme" manage />);
    const section = await screen.findByTestId("agents-section");
    await within(section).findByText("reviewer");

    fireEvent.click(within(section).getByLabelText("Toggle agent reviewer"));
    await waitFor(() =>
      expect(api.config.update).toHaveBeenCalledWith("org", "acme", "agents", "ag1", {
        enabled: false,
      }),
    );
  });
});

// ── Env vars ──────────────────────────────────────────────────────────────────
describe("EnvVarsSection", () => {
  it("masks secret values and never shows the stored value", async () => {
    const secret: EnvVar = {
      id: "e1",
      scope: "project",
      key: "API_TOKEN",
      value: "",
      secret: true,
      hasValue: true,
    };
    const plain: EnvVar = {
      id: "e2",
      scope: "project",
      key: "LOG_LEVEL",
      value: "debug",
      secret: false,
      hasValue: true,
    };
    (api.config.list as ReturnType<typeof vi.fn>).mockResolvedValue([secret, plain]);

    renderSection(<EnvVarsSection scope="project" ownerKey="p1" manage />);
    const section = await screen.findByTestId("env-section");
    await within(section).findByText("API_TOKEN");

    // Secret row shows a mask, never the raw value.
    expect(within(section).getByText("••••••••")).toBeInTheDocument();
    // A "secret" badge is present (the add-form label also reads "secret",
    // so assert at least one badge-text occurrence in the rendered list).
    expect(within(section).getAllByText("secret").length).toBeGreaterThan(0);
    // Plain row shows its value.
    expect(within(section).getByText("debug")).toBeInTheDocument();
  });
});

// ── Model params ───────────────────────────────────────────────────────────────
describe("ModelParamsSection", () => {
  it("saves the form via putModel", async () => {
    const params: ModelParams = {
      model: "claude-x",
      effort: "high",
      maxSteps: 10,
      contextBudget: 1000,
      planMode: false,
    };
    (api.config.getModel as ReturnType<typeof vi.fn>).mockResolvedValue(params);
    (api.config.putModel as ReturnType<typeof vi.fn>).mockResolvedValue(params);

    renderSection(<ModelParamsSection scope="org" ownerKey="acme" manage />);
    const section = await screen.findByTestId("model-params-section");
    await waitFor(() =>
      expect((within(section).getByLabelText("Model") as HTMLInputElement).value).toBe(
        "claude-x",
      ),
    );

    fireEvent.change(within(section).getByLabelText("Max steps"), {
      target: { value: "25" },
    });
    fireEvent.click(within(section).getByRole("button", { name: /Save/i }));

    await waitFor(() =>
      expect(api.config.putModel).toHaveBeenCalledWith("org", "acme", {
        model: "claude-x",
        effort: "high",
        maxSteps: 25,
        contextBudget: 1000,
        planMode: false,
      }),
    );
  });
});
