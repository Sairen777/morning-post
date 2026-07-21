/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import Dashboard from "./Dashboard";
import type {
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
  connected: true,
  createdAt: 0,
  updatedAt: 0,
};

const user: PublicUser = {
  id: "user-1",
  name: "Dashboard Reader",
  email: "dashboard-reader@example.com",
  systemPrompt: "",
  defaultLanguage: null,
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

function emptyDigestPage() {
  return { data: [], nextCursor: null };
}

function dashboardResponse(
  path: string,
  digestRunsResponse: unknown,
  digestResponse: unknown = emptyDigestPage(),
) {
  if (path === "/sources") return jsonResponse([]);
  if (path === "/feeds") return jsonResponse([]);
  if (path === "/digests/runs") return jsonResponse(digestRunsResponse);
  if (path === "/digests") return jsonResponse(digestResponse);
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
      expect(screen.getByRole("status")).toHaveTextContent(
        "A digest is running.",
      );
      expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Open Runs tab" })).toBeVisible();
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

  it("polls an active run every five seconds and refreshes digests after completion", async () => {
    vi.useFakeTimers();
    let digestRunRequestCount = 0;
    let digestRequestCount = 0;
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      if (path === "/digests/runs") {
        digestRunRequestCount += 1;
        const response = digestRunRequestCount === 1
          ? { data: [activeDigestRun], nextCursor: null }
          : { data: [completedDigestRun], nextCursor: null };
        return Promise.resolve(jsonResponse(response));
      }
      if (path === "/digests") {
        digestRequestCount += 1;
        return Promise.resolve(jsonResponse(emptyDigestPage()));
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

    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(5_100);
    expect(digestRunRequestCount).toBe(2);
    expect(digestRequestCount).toBe(2);
    expect(screen.getByRole("button", { name: "Run digest" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open Runs tab" })).toBeNull();
    vi.useRealTimers();
  });
});
