import { test, expect } from "@playwright/test";

const PASSWORD = "smoke-test-password-1843";

test("set up owner, save profile, run digest, and log back in", async ({ page }) => {
  await page.goto("/");

  // Should see the first-run owner setup form initially
  await expect(page.locator(".auth-panel")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Set up your owner account" }),
  ).toBeVisible();

  await page.fill("#auth-name", "E2E Smoke");
  await page.fill("#auth-password", PASSWORD);
  await page.click('button[type="submit"]');

  // Setup returns the authenticated owner directly.
  await expect(page.locator(".app-header")).toContainText("E2E Smoke");

  // Click Run digest with blank period fields
  await page.click('button:has-text("Run digest")');

  // Should see a digest appear with status complete
  await expect(page.locator(".badge-success")).toBeVisible({ timeout: 15_000 });

  // Navigate to Profile tab
  await page.click('button:has-text("Profile")');
  await expect(page.locator("#profile-model")).toHaveCount(0);

  // Edit profile name
  await page.fill("#profile-name", "E2E Updated Smoke");
  // Save profile
  await page.click('button:has-text("Save profile")');

  // Should see "Profile saved" confirmation
  await expect(page.locator("text=Profile saved")).toBeVisible({ timeout: 5_000 });

  // Navigate to Runs tab
  await page.click('button:has-text("Runs")');

  // Should see the manual digest run
  await expect(page.locator("text=manual")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("text=complete")).toBeVisible({ timeout: 5_000 });

  // Log out, then use the password-only sign-in form.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator(".auth-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("#auth-name")).toHaveCount(0);
  await page.fill("#auth-password", PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator(".app-header")).toContainText("E2E Updated Smoke");
});

