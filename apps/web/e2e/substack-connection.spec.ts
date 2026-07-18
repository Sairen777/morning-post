import { test, expect } from "@playwright/test";

test("connects Substack and adds a publication without exposing cookie values", async ({ page }) => {
  const secret = "session-secret-do-not-render";
  const compatibility = "compatibility-secret-do-not-render";
  let connected = false;
  const source = {
    id: "source-substack",
    userId: "user-1",
    connectorId: "Substack",
    position: null,
    enabled: true,
    connected: true,
    createdAt: 0,
    updatedAt: 0,
  };

  await page.route("**/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "user-1",
        name: "E2E User",
        email: "e2e@example.com",
        systemPrompt: "",
        defaultLanguage: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    });
  });
  await page.route("**/sources", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connected ? [source] : []),
    });
  });
  await page.route("**/feeds", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/digests**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/connectors/substack/session", async (route) => {
    connected = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source }) });
  });
  await page.route("**/connectors/substack/publications", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        source,
        feed: {
          id: "feed-1",
          sourceId: source.id,
          externalId: "https://example.substack.com",
          name: "Example",
          kind: "news",
          customPrompt: null,
          position: null,
          enabled: true,
          deletedAt: null,
          lastFetchedPeriodEndMs: null,
          createdAt: 0,
        },
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator(".app-header")).toContainText("e2e@example.com");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByLabel("substack.sid session credential").fill(secret);
  await page.locator("summary").nth(1).click();
  await page.getByLabel("connect.sid compatibility credential").fill(compatibility);
  await page.getByRole("button", { name: /save session|connect substack/i }).click();
  await expect(page.getByText(/Substack session connected/i)).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(secret);
  expect(await page.locator("body").textContent()).not.toContain(compatibility);

  await expect(page.locator("#substack-publication-url")).toBeVisible();
  await page.locator("#substack-publication-url").fill("https://example.substack.com");
  await page.getByRole("button", { name: /add publication/i }).click();
  await expect(page.getByText("Publication added")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(secret);
  expect(await page.locator("body").textContent()).not.toContain(compatibility);
});
