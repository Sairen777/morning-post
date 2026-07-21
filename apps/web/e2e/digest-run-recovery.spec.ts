import { expect, test } from "@playwright/test";

const user = {
  id: "user-digest-recovery",
  name: "Digest recovery reader",
  email: "digest-recovery@example.com",
  systemPrompt: "Summarize clearly",
  defaultLanguage: "en",
  createdAt: 1_704_067_200_000,
  updatedAt: 1_704_067_200_000,
};

const startedAt = Date.UTC(2026, 6, 21, 12, 0, 0);
const activeRun = {
  id: "digest-run-recovery",
  digestId: null,
  userId: user.id,
  trigger: "manual" as const,
  periodStartMs: startedAt - 86_400_000,
  periodEndMs: startedAt,
  status: "running" as const,
  startedAt,
  finishedAt: null,
  errorMessage: null,
};

test("recovers an active digest after reload and releases the run action", async ({
  page,
}) => {
  let activeRunStatus: "running" | "complete" = "running";
  let digestRunRequestCount = 0;

  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const requestMethod = route.request().method();

    if (requestUrl.pathname === "/auth/me" && requestMethod === "GET") {
      await route.fulfill({ json: user });
      return;
    }
    if (requestUrl.pathname === "/sources" && requestMethod === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (requestUrl.pathname === "/feeds" && requestMethod === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (requestUrl.pathname === "/digests" && requestMethod === "GET") {
      await route.fulfill({ json: { data: [], nextCursor: null } });
      return;
    }
    if (requestUrl.pathname === "/digests/runs" && requestMethod === "GET") {
      digestRunRequestCount += 1;
      await route.fulfill({
        json: {
          data: [{ ...activeRun, status: activeRunStatus }],
          nextCursor: null,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.clock.install({ time: new Date(startedAt) });
  await page.goto("/");
  await expect(page.locator(".app-header")).toContainText(user.email);

  const runDigestButton = page.getByRole("button", { name: "Run digest" });
  await expect(runDigestButton).toBeVisible();
  await expect(runDigestButton).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(
    "A digest is running.",
  );
  await expect(page.getByRole("status")).toContainText("Started");
  await expect(page.getByRole("button", { name: "Open Runs tab" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/digest already running/i);

  await page.reload();
  await expect(runDigestButton).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(
    "A digest is running.",
  );
  await expect(page.locator("body")).not.toContainText(/digest already running/i);

  await page.getByRole("button", { name: "Open Runs tab" }).click();
  await expect(page.getByRole("heading", { name: "Digest runs" })).toBeVisible();
  await expect(page.getByText("running", { exact: true })).toBeVisible();

  const requestsBeforeTerminalPolling = digestRunRequestCount;
  activeRunStatus = "complete";
  await page.clock.runFor(5_000);
  await expect.poll(() => digestRunRequestCount).toBeGreaterThan(
    requestsBeforeTerminalPolling,
  );

  await page.getByRole("button", { name: "Digests" }).click();
  await expect(runDigestButton).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/digest already running/i);
});
