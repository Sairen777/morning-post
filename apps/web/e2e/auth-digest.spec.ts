import { test, expect } from "@playwright/test";

const UNIQUE_ID = Date.now();
const EMAIL = `e2e-smoke-${UNIQUE_ID}@example.com`;
const PASSWORD = "smoke-test-password-1843";

test("register, save profile, run digest, and verify runs tab", async ({ page }) => {
  await page.goto("/");

  // Should see auth panel initially
  await expect(page.locator(".auth-panel")).toBeVisible();

  // Switch to register mode
  await page.click("text=Register");

  // Fill registration form
  await page.fill("#auth-name", "E2E Smoke");
  await page.fill("#auth-email", EMAIL);
  await page.fill("#auth-password", PASSWORD);
  await page.click('button[type="submit"]');

  // Should now see dashboard with user email
  await expect(page.locator(".app-header")).toContainText(EMAIL);

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
});
