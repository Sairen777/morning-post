import { expect, test } from "@playwright/test";

test("connects Substack and adds a publication without exposing cookie values", async ({ page }) => {
  const secret = "session-secret-do-not-render";
  const replacementSecret = "replacement-secret-do-not-render";
  const compatibilitySecret = "compatibility-secret-do-not-render";
  const sessionRequests: unknown[] = [];
  let connected = false;
  const publications: Array<{
    id: string;
    sourceId: string;
    externalId: string;
    name: string;
    kind: "news";
    customPrompt: null;
    position: null;
    enabled: true;
    deletedAt: null;
    lastFetchedPeriodEndMs: null;
    createdAt: number;
    updatedAt: number;
  }> = [{
    id: "feed-existing",
    sourceId: "source-substack",
    externalId: "https://already-followed.substack.com",
    name: "Already followed",
    kind: "news",
    customPrompt: null,
    position: null,
    enabled: true,
    deletedAt: null,
    lastFetchedPeriodEndMs: null,
    createdAt: 0,
    updatedAt: 0,
  }];
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connected ? publications : []),
    });
  });
  await page.route("**/digests**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route("**/connectors/substack/session", async (route) => {
    sessionRequests.push(route.request().postDataJSON());
    connected = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source }),
    });
  });
  await page.route("**/connectors/substack/publications", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            externalId: "https://already-followed.substack.com",
            name: "Already followed",
            kind: "news",
          },
          {
            externalId: "https://new.substack.com",
            name: "New publication",
            kind: "news",
          },
        ]),
      });
      return;
    }

    const body = route.request().postDataJSON() as { publicationUrl: string };
    const feed = {
      id: `feed-${publications.length + 1}`,
      sourceId: source.id,
      externalId: body.publicationUrl,
      name: body.publicationUrl.includes("new.substack.com")
        ? "New publication"
        : "Manual publication",
      kind: "news" as const,
      customPrompt: null,
      position: null,
      enabled: true as const,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: 0,
      updatedAt: 0,
    };
    publications.push(feed);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ source, feed }),
    });
  });

  await page.goto("/");
  await expect(page.locator(".app-header")).toContainText("e2e@example.com");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByLabel("substack.sid session credential").fill(secret);
  await page.getByRole("button", { name: /save session|connect substack/i })
    .click();
  await expect(page.getByText(/Substack session connected/i)).toBeVisible();
  expect(sessionRequests).toEqual([{ substackSessionId: secret }]);
  await expect(page.getByLabel("substack.sid session credential")).toHaveValue(
    "",
  );
  await expect(page.getByLabel("connect.sid session credential (optional)"))
    .toHaveValue("");
  await page.getByLabel("substack.sid session credential").fill(
    replacementSecret,
  );
  await page.getByLabel("connect.sid session credential (optional)").fill(
    compatibilitySecret,
  );
  await page.getByRole("button", {
    name: /replace substack session|connect substack/i,
  }).click();
  await expect.poll(() => sessionRequests.length).toBe(2);
  expect(sessionRequests[1]).toEqual({
    substackSessionId: replacementSecret,
    connectSessionId: compatibilitySecret,
  });
  await expect(page.getByLabel("substack.sid session credential")).toHaveValue(
    "",
  );
  await expect(page.getByLabel("connect.sid session credential (optional)"))
    .toHaveValue("");
  expect(await page.locator("body").textContent()).not.toContain(
    replacementSecret,
  );
  expect(await page.locator("body").textContent()).not.toContain(
    compatibilitySecret,
  );
  expect(await page.locator("body").textContent()).not.toContain(secret);

  await expect(page.locator("#substack-publication-url")).toBeVisible();
  await page.getByRole("button", { name: "Find followed publications" })
    .click();
  await expect(page.getByText("New publication")).toBeVisible();
  const existingRow = page.locator(".publication-row").filter({
    hasText: "Already followed",
  });
  await expect(
    existingRow.getByRole("button", { name: "Added Already followed" }),
  ).toBeDisabled();
  const newRow = page.locator(".publication-row").filter({
    hasText: "New publication",
  });
  await newRow.getByRole("button", { name: "Add New publication" }).click();
  await expect(
    newRow.getByRole("button", { name: "Added New publication" }),
  ).toBeDisabled();

  await page.locator("#substack-publication-url").fill(
    "https://manual.substack.com",
  );
  await page.getByRole("button", { name: /add publication/i }).click();
  await expect(page.getByText("Publication added")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(secret);
});
