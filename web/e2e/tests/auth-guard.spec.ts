import { test, expect } from "@playwright/test";
import { installMocks } from "./fixtures";

test.describe("auth guard", () => {
  test("unauthenticated visit to / redirects to /login", async ({ page }) => {
    // `/bff/me` → 401: the root loader throws a redirect to /login.
    await installMocks(page, { authenticated: false });

    await page.goto("/");

    await expect(page).toHaveURL(/\/login(\?.*)?$/);
    await expect(page.getByRole("link", { name: /sign in with github/i })).toBeVisible();
  });

  test("authenticated visit to / lands on the org project list", async ({ page }) => {
    await installMocks(page, { authenticated: true });

    await page.goto("/");

    // index loader redirects `/` → `/:org` (first org slug = "acme").
    await expect(page).toHaveURL(/\/acme$/);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    // The mocked project shows up in the list.
    await expect(page.getByText("Web Client")).toBeVisible();
    await expect(page.getByText("acme/web-client")).toBeVisible();
  });
});
