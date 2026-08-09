/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import Dashboard from "./Dashboard";
import type {
  PublicDigest,
  PublicDigestRun,
  PublicFeed,
  PublicSource,
  PublicUser,
} from "../api/types";

const source: PublicSource = {
  id: "source-substack",
  userId: "user-1",
  connectorId: "Substack",
  position: null,
  enabled: true,
  showPaidPostTitles: false,
  relevanceFilterMode: "inherit",
  connected: true,
  createdAt: 0,
  updatedAt: 0,
};

const user: PublicUser = {
  id: "user-1",
  name: "Dashboard Reader",
  systemPrompt: "",
  summaryPrompt: "",
  defaultLanguage: null,
  defaultRelevanceFilterMode: "personalized",
  storyDetailLevel: "balanced",
  relevanceThreshold: 60,
  maximumStoriesPerDigest: null,
  interestProfileVersion: 1,
  createdAt: 0,
  updatedAt: 0,
};

function feed(id: string, externalId: string, name: string): PublicFeed {
  return {
    id,
    sourceId: source.id,
    externalId,
    name,
    kind: "news",
    customPrompt: null,
    position: null,
    enabled: true,
    summarizationMode: "basic",
    relevanceFilterMode: "inherit",
    deletedAt: null,
    lastFetchedPeriodEndMs: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

function createDeferred<Result>() {
  let resolvePromise!: (value: Result | PromiseLike<Result>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<Result>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Dashboard Substack refresh ordering", () => {
  it(
    "ignores an older feed snapshot when concurrent publication additions refresh out of order",
    async () => {
      const publicationA = {
        externalId: "https://publication-a.substack.com",
        name: "Publication A",
        kind: "news" as const,
      };
      const publicationB = {
        externalId: "https://publication-b.substack.com",
        name: "Publication B",
        kind: "news" as const,
      };
      const feedA = feed("feed-a", publicationA.externalId, publicationA.name);
      const feedB = feed("feed-b", publicationB.externalId, publicationB.name);
      const firstRefresh = createDeferred<Response>();
      const secondRefresh = createDeferred<Response>();
      let feedRequestCount = 0;

      globalThis.fetch = vi.fn((input, init) => {
        const path = String(input);
        if (path === "/interests") return Promise.resolve(jsonResponse([]));
        if (path === "/sources") return Promise.resolve(jsonResponse([source]));
        if (path.startsWith("/digests") || path.startsWith("/digest-runs")) {
          return Promise.resolve(jsonResponse({ data: [], nextCursor: null }));
        }
        if (path === "/feeds") {
          feedRequestCount += 1;
          if (feedRequestCount === 1) return Promise.resolve(jsonResponse([]));
          if (feedRequestCount === 2) return firstRefresh.promise;
          if (feedRequestCount === 3) return secondRefresh.promise;
          return Promise.resolve(jsonResponse([feedA, feedB]));
        }
        if (
          path === "/connectors/substack/publications" &&
          init?.method === "POST"
        ) {
          const { publicationUrl } = JSON.parse(init.body as string) as {
            publicationUrl: string;
          };
          const addedFeed = publicationUrl === publicationA.externalId
            ? feedA
            : feedB;
          return Promise.resolve(
            jsonResponse({ source, feed: addedFeed }, 201),
          );
        }
        if (path === "/connectors/substack/publications") {
          return Promise.resolve(jsonResponse([publicationA, publicationB]));
        }
        throw new Error(`Unexpected request: ${path}`);
      }) as typeof fetch;

      render(() => (
        <Dashboard
          user={user}
          onLogout={() => {}}
          onAuthError={() => {}}
          onUserUpdate={() => {}}
        />
      ));

      await waitFor(() => expect(feedRequestCount).toBe(1));
      await fireEvent.click(
        screen.getByRole("button", { name: "Connections" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Substack/ })).toBeVisible()
      );
      await fireEvent.click(screen.getByRole("button", { name: /Substack/ }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Find followed publications" }),
        )
          .toBeVisible()
      );
      await fireEvent.click(
        screen.getByRole("button", { name: "Find followed publications" }),
      );
      await waitFor(() =>
        expect(screen.getByText("Publication A")).toBeVisible()
      );

      await fireEvent.click(
        screen.getByRole("button", { name: "Add Publication A" }),
      );
      await fireEvent.click(
        screen.getByRole("button", { name: "Add Publication B" }),
      );
      await waitFor(() => expect(feedRequestCount).toBe(3));

      secondRefresh.resolve(jsonResponse([feedA, feedB]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      firstRefresh.resolve(jsonResponse([feedA]));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await fireEvent.click(screen.getByRole("button", { name: "Digests" }));
      await fireEvent.click(
        screen.getByRole("button", { name: "Connections" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Substack/ })).toBeVisible()
      );
      await fireEvent.click(screen.getByRole("button", { name: /Substack/ }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Find followed publications" }),
        )
          .toBeVisible()
      );
      await fireEvent.click(
        screen.getByRole("button", { name: "Find followed publications" }),
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Added Publication A" }))
          .toBeDisabled()
      );
      expect(screen.getByRole("button", { name: "Added Publication B" }))
        .toBeDisabled();
    },
    15_000,
  );
});

const activeDigestRun: PublicDigestRun = {
  id: "run-active",
  digestId: null,
  userId: user.id,
  trigger: "manual",
  periodStartMs: 1_700_000_000_000,
  periodEndMs: 1_700_086_400_000,
  status: "running",
  startedAt: 1_700_000_123_000,
  finishedAt: null,
  errorMessage: null,
};

const completedDigestRun: PublicDigestRun = {
  ...activeDigestRun,
  id: "run-complete",
  status: "complete",
  finishedAt: 1_700_086_500_000,
};

function digestRecord(id: string, periodStartMs: number): PublicDigest {
  return {
    id,
    userId: user.id,
    periodStartMs,
    periodEndMs: periodStartMs + 86_400_000,
    status: "complete",
    createdAt: periodStartMs,
    updatedAt: periodStartMs,
  };
}

function emptyDigestPage() {
  return { data: [], nextCursor: null };
}

function dashboardResponse(
  path: string,
  digestRunsResponse: unknown,
  digestResponse: unknown = emptyDigestPage(),
) {
  if (path === "/sources") return jsonResponse([]);
  if (path === "/interests") return jsonResponse([]);
  if (path === "/feeds") return jsonResponse([]);
  if (path === "/digests/runs") return jsonResponse(digestRunsResponse);
  if (path === "/digests" || path.startsWith("/digests?")) {
    return jsonResponse(digestResponse);
  }
  throw new Error(`Unexpected request: ${path}`);
}

describe("Dashboard digest run recovery", () => {
  it("keeps submission disabled while the initial run status is pending", async () => {
    const runStatus = createDeferred<Response>();
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      if (path === "/digests/runs") return runStatus.promise;
      return Promise.resolve(dashboardResponse(path, emptyDigestPage()));
    }) as typeof fetch;

    render(() => (
      <Dashboard
        user={user}
        onLogout={() => {}}
        onAuthError={() => {}}
        onUserUpdate={() => {}}
      />
    ));

    expect(
      screen.getByRole("button", { name: "Checking run status…" }),
    ).toBeDisabled();
    expect(screen.getByText("Checking whether a digest is already running…"))
      .toBeVisible();

    runStatus.resolve(jsonResponse(emptyDigestPage()));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run digest" })).toBeEnabled()
    );
  });

  it("disables submission after reload when the initial response has a running row", async () => {
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      return Promise.resolve(
        dashboardResponse(path, { data: [activeDigestRun], nextCursor: null }),
      );
    }) as typeof fetch;

    render(() => (
      <Dashboard
        user={user}
        onLogout={() => {}}
        onAuthError={() => {}}
        onUserUpdate={() => {}}
      />
    ));

    await waitFor(() => {
      expect(
        within(screen.getByRole("region", { name: "Run Digest" }))
          .getByRole("status"),
      ).toHaveTextContent("A digest is running.");
      expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Open Runs tab" })).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Open Runs tab" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^Activity/ })).toHaveAttribute(
        "aria-selected",
        "true",
      )
    );
    expect(screen.getByRole("heading", { name: "Activity" })).toBeVisible();
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });

  it("shows a retryable status error instead of enabling an unchecked run", async () => {
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      if (path === "/digests/runs") {
        return Promise.resolve(jsonResponse({ error: { message: "backend details" } }, 503));
      }
      return Promise.resolve(dashboardResponse(path, emptyDigestPage()));
    }) as typeof fetch;

    render(() => (
      <Dashboard
        user={user}
        onLogout={() => {}}
        onAuthError={() => {}}
        onUserUpdate={() => {}}
      />
    ));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "We couldn't confirm whether a digest is already running.",
      );
      expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();
    });
    expect(screen.getByRole("alert")).not.toHaveTextContent("backend details");
    expect(
      screen.getByRole("button", { name: "Retry status check" }),
    ).toBeVisible();
  });

  it("polls an active run every five seconds and refreshes digests once after completion", async () => {
    vi.useFakeTimers();
    let digestRunRequestCount = 0;
    let digestRequestCount = 0;
    const initialDigestPage = createDeferred<Response>();
    const completionDigestPage = createDeferred<Response>();
    const sortedDigestPage = createDeferred<Response>();
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      if (path === "/digests/runs") {
        digestRunRequestCount += 1;
        const response = digestRunRequestCount === 1
          ? { data: [activeDigestRun], nextCursor: null }
          : { data: [completedDigestRun], nextCursor: null };
        return Promise.resolve(jsonResponse(response));
      }
      if (path === "/digests?sort=requested_desc") {
        digestRequestCount += 1;
        return digestRequestCount === 1
          ? initialDigestPage.promise
          : completionDigestPage.promise;
      }
      if (path === "/digests?sort=requested_asc") {
        digestRequestCount += 1;
        return sortedDigestPage.promise;
      }
      return Promise.resolve(dashboardResponse(path, emptyDigestPage()));
    }) as typeof fetch;

    render(() => (
      <Dashboard
        user={user}
        onLogout={() => {}}
        onAuthError={() => {}}
        onUserUpdate={() => {}}
      />
    ));

    const runnerCard = () =>
      screen.getByRole("region", { name: "Run Digest" });
    const archiveLink = () =>
      screen.getByRole("link", { name: /read digest/ });

    await vi.advanceTimersByTimeAsync(0);
    expect(digestRunRequestCount).toBe(1);
    expect(digestRequestCount).toBe(1);
    expect(within(runnerCard()).getByRole("status")).toHaveTextContent(
      "A digest is running.",
    );
    expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(5_100);
    expect(digestRunRequestCount).toBe(2);
    expect(digestRequestCount).toBe(2);
    expect(screen.getByRole("button", { name: "Run digest" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open Runs tab" })).toBeNull();

    await fireEvent.change(screen.getByLabelText("Order by"), {
      target: { value: "requested_asc" },
    });
    expect(digestRequestCount).toBe(3);

    const freshDigest = digestRecord("digest-fresh", 1_700_100_000_000);
    const staleDigest = digestRecord("digest-stale", 1_700_200_000_000);
    const sortedDigest = digestRecord("digest-sorted", 1_700_300_000_000);

    sortedDigestPage.resolve(
      jsonResponse({ data: [sortedDigest], nextCursor: null }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(archiveLink().getAttribute("href")).toBe(
      `/issues/${sortedDigest.id}`,
    );

    // The completion refresh carries the pre-change sort, so it is now a
    // stale request and must not replace the archive.
    completionDigestPage.resolve(
      jsonResponse({ data: [freshDigest], nextCursor: null }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(archiveLink().getAttribute("href")).toBe(
      `/issues/${sortedDigest.id}`,
    );

    // The mount-time digest request is the oldest generation; it must not
    // replace the archive either.
    initialDigestPage.resolve(
      jsonResponse({ data: [staleDigest], nextCursor: null }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(archiveLink().getAttribute("href")).toBe(
      `/issues/${sortedDigest.id}`,
    );

    // Polling stops once the run completes: no further five-second ticks or
    // completion-triggered refreshes.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(digestRunRequestCount).toBe(2);
    expect(digestRequestCount).toBe(3);
  });
});

describe("Dashboard section query navigation", () => {
  it("opens Profile from ?section=profile and returns to Digests on reader return", async () => {
    window.history.replaceState(null, "", "/?section=profile");
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      return Promise.resolve(dashboardResponse(path, emptyDigestPage()));
    }) as typeof fetch;

    render(() => (
      <Dashboard
        user={user}
        onLogout={() => {}}
        onAuthError={() => {}}
        onUserUpdate={() => {}}
      />
    ));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Preferences/ })).toBeVisible()
    );
    expect(screen.getByRole("heading", { name: "Profile" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run digest" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Digests" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run digest" })).toBeVisible()
    );
    expect(screen.queryByRole("tab", { name: /Preferences/ })).toBeNull();
    expect(window.location.search).toBe("");

    await fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(new URLSearchParams(window.location.search).get("section")).toBe(
      "profile",
    );

    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run digest" })).toBeVisible()
    );
    expect(screen.queryByRole("tab", { name: /Preferences/ })).toBeNull();
  });
});
