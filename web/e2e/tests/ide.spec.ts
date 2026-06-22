import { test, expect } from "@playwright/test";
import { installMocks } from "./fixtures";

test.describe("IDE session view", () => {
  test("navigating project → session opens the IDE with three panes and streamed events", async ({
    page,
  }) => {
    await installMocks(page, { authenticated: true });

    // Land on the org project list, then drill into the project.
    await page.goto("/acme");
    await page.getByText("Web Client").click();

    // Project overview: session list.
    await expect(page).toHaveURL(/\/acme\/proj_1$/);
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    // Open the session → the IDE split-view.
    await page.getByText("Implement login flow").click();
    await expect(page).toHaveURL(/\/acme\/proj_1\/s\/sess_1$/);

    // Pane 1: the file tree (role=tree) with the working-copy entries.
    const tree = page.getByRole("tree", { name: "File tree" });
    await expect(tree).toBeVisible();
    await expect(tree.getByText("README.md")).toBeVisible();
    await expect(tree.getByText("src")).toBeVisible();

    // Pane 2: the editor/diff pane (File/Diff toggle is present).
    await expect(page.getByRole("button", { name: "File" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Diff" })).toBeVisible();

    // Pane 3: the agent panel — streamed events from the mocked SSE appear.
    const agent = page.getByTestId("agent-scroll");
    await expect(agent).toBeVisible();
    await expect(agent.getByText("Starting work on the login flow.")).toBeVisible();
    await expect(agent.getByText("read_file")).toBeVisible();
    // The file_changed frame surfaces in the event log.
    await expect(agent.getByText("README.md")).toBeVisible();
  });

  test("selecting a file in the tree opens it in the editor", async ({ page }) => {
    await installMocks(page, { authenticated: true });

    await page.goto("/acme/proj_1/s/sess_1");

    const tree = page.getByRole("tree", { name: "File tree" });
    await expect(tree).toBeVisible();
    await tree.getByText("README.md").click();

    // The read view (CodeMirror) mounts once the file loads, and its content
    // (from the mocked /bff/.../file response) renders.
    const reader = page.getByTestId("cm-read");
    await expect(reader).toBeVisible();
    await expect(reader.getByText("Hello from the mocked working copy.")).toBeVisible();
  });
});
