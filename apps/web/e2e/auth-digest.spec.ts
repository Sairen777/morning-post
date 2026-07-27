import { test, expect } from "@playwright/test";

test("set up Morning Post, save profile, run digest, and continue back in", async ({ page }) => {
  await page.goto("/");

  // First run asks only for the name shown in digests.
  await expect(page.locator(".auth-panel")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome to Morning Post" }),
  ).toBeVisible();
  await expect(
    page.getByText("Choose the name shown in your digests."),
  ).toBeVisible();
  await expect(page.locator("#auth-password")).toHaveCount(0);

  await page.fill("#auth-name", "E2E Smoke");
  await page.getByRole("button", { name: "Get started" }).click();

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

  // Passwordless owners return through a one-click continuation.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator(".auth-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.locator("#auth-name")).toHaveCount(0);
  await expect(page.locator("#auth-password")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".app-header")).toContainText("E2E Updated Smoke");
});

