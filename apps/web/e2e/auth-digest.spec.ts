import { test, expect } from "@playwright/test";

const UNIQUE_ID = Date.now();
const EMAIL = `e2e-smoke-${UNIQUE_ID}@example.com`;
const PASSWORD = "smoke-test-password-1843";

test("register, run digest, and verify digest appears", async ({ page }) => {
  await page.goto("/");

  // Should see auth panel initially
  await expect(page.locator(".auth-panel")).toBeVisible();

  // Switch to register mode
  await page.click("text=Register");

  // Fill registration form
  await page.fill("#auth-name", "E2E Smoke");
  await page.fill("#auth-email", EMAIL);
  await page.fill("#auth-password", PASSWORD);
  // Submit registration
  await page.click('button[type="submit"]');

  // Should now see dashboard with user email
  await expect(page.locator(".app-header")).toContainText(EMAIL);

  // Click Run digest with blank period fields
  await page.click('button:has-text("Run digest")');

  // Should see a digest appear with status complete
  await expect(page.locator(".badge-success")).toBeVisible({ timeout: 15_000 });
});
