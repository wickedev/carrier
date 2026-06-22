import { test, expect } from "@playwright/test";
import { installMocks } from "./fixtures";

test.describe("login page", () => {
  test("renders the GitHub sign-in CTA", async ({ page }) => {
    await installMocks(page, { authenticated: false });

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Carrier" })).toBeVisible();
    const cta = page.getByRole("link", { name: /sign in with github/i });
    await expect(cta).toBeVisible();
    // The CTA points at the BFF OAuth start endpoint.
    await expect(cta).toHaveAttribute("href", "/auth/github");
  });
});
