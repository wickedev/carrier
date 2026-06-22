import { test, expect } from "@playwright/test";
import { installMocks, STREAM_EVENTS, APPROVAL_EVENT } from "./fixtures";

test.describe("HITL approval", () => {
  test("an approval_request frame surfaces an approval card with approve/deny", async ({
    page,
  }) => {
    // Stream the normal frames plus the approval_request frame.
    await installMocks(page, {
      authenticated: true,
      streamEvents: [...STREAM_EVENTS, APPROVAL_EVENT],
    });

    await page.goto("/acme/proj_1/s/sess_1");

    // The approval card renders (role=alertdialog, with the tool + reason).
    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Approval required")).toBeVisible();
    await expect(card.getByText("bash")).toBeVisible();
    await expect(card.getByText("rm -rf build")).toBeVisible();

    // Approve / Deny controls exist.
    const approve = card.getByRole("button", { name: "Approve" });
    const deny = card.getByRole("button", { name: "Deny" });
    await expect(approve).toBeVisible();
    await expect(deny).toBeVisible();

    // Approving resolves the request: POST /approvals/:reqId is sent and the
    // card is removed from the pending list.
    const approvalReq = page.waitForRequest(
      (req) => /\/bff\/sessions\/sess_1\/approvals\/req_1$/.test(req.url()) && req.method() === "POST",
    );
    await approve.click();
    await approvalReq;
    await expect(card).toBeHidden();
  });
});
