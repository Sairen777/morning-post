/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import Dashboard from "./Dashboard";
import type { PublicFeed, PublicSource, PublicUser } from "../api/types";

const source: PublicSource = {
  id: "source-substack",
  userId: "user-1",
  connectorId: "Substack",
  position: null,
  enabled: true,
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
