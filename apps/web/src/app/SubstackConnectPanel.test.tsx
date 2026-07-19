/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import SubstackConnectPanel from "./SubstackConnectPanel";
import type { PublicFeed, PublicSource } from "../api/types";

const connectedSource: PublicSource = {
  id: "source-1",
  userId: "user-1",
  connectorId: "Substack",
  position: null,
  enabled: true,
  showPaidPostTitles: false,
  connected: true,
  createdAt: 0,
  updatedAt: 0,
};

const disconnectedSource: PublicSource = {
  ...connectedSource,
  connected: false,
  enabled: false,
};

const existingFeed: PublicFeed = {
  id: "feed-existing",
  sourceId: "source-1",
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
};

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

describe("SubstackConnectPanel", () => {
  it("discloses the unsupported full-account credential flow without rendering a raw Cookie field", () => {
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    expect(container.textContent).toContain("unsupported");
    expect(container.textContent).toContain("full-account");
    expect(container.textContent).toContain("DevTools");
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(container.querySelector('input[name="Cookie"]')).toBeNull();
    const sid = container.querySelector<HTMLInputElement>(
      "#substack-session-id",
    );
    expect(sid?.type).toBe("password");
    expect(sid?.getAttribute("autocomplete")).toBe("off");
    expect(sid?.required).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>("#connect-session-id")
        ?.required,
    ).toBe(false);
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(
      false,
    );
  });

  it("accepts substack.sid alone, clears its value after success, and refreshes", async () => {
    const onConnected = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            source: connectedSource,
          }),
          { status: 200 },
        ),
      )
    ) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        feeds={[]}
        onConnected={onConnected}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    const connectSid = container.querySelector<HTMLInputElement>(
      "#connect-session-id",
    );
    expect(connectSid).not.toBeNull();
    const sid = container.querySelector<HTMLInputElement>(
      "#substack-session-id",
    )!;
    await fireEvent.input(sid, { target: { value: "sid-secret" } });
    await fireEvent.click(
      screen.getByRole("button", { name: /save session|connect substack/i }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(sid.value).toBe("");
    expect(connectSid!.value).toBe("");
    expect(container.textContent).toContain("connected");
    expect(container.textContent).not.toContain("sid-secret");
  });

  it("submits and clears the optional connect.sid value when supplied", async () => {
    const onConnected = vi.fn(() => Promise.resolve());
    const requestBodies: unknown[] = [];
    globalThis.fetch = vi.fn((_input, init) => {
      requestBodies.push(JSON.parse(init?.body as string));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            source: connectedSource,
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        feeds={[]}
        onConnected={onConnected}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    const sid = container.querySelector<HTMLInputElement>(
      "#substack-session-id",
    )!;
    const connectSid = container.querySelector<HTMLInputElement>(
      "#connect-session-id",
    )!;
    await fireEvent.input(sid, { target: { value: "sid-secret" } });
    await fireEvent.input(connectSid, { target: { value: "connect-secret" } });
    await fireEvent.click(
      screen.getByRole("button", { name: /connect substack/i }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(requestBodies).toEqual([{
      substackSessionId: "sid-secret",
      connectSessionId: "connect-secret",
    }]);
    expect(sid.value).toBe("");
    expect(connectSid.value).toBe("");
    expect(container.textContent).not.toContain("sid-secret");
    expect(container.textContent).not.toContain("connect-secret");
  });

  it("sends Morning Post auth failures to the callback and keeps safe upstream errors", async () => {
    const onAuthError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "SESSION_INVALID", message: "Session rejected" },
          }),
          { status: 422 },
        ),
      )
    ) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={onAuthError}
      />
    ));
    const sid = container.querySelector<HTMLInputElement>(
      "#substack-session-id",
    )!;
    await fireEvent.input(sid, { target: { value: "sid-secret" } });
    await fireEvent.click(
      screen.getByRole("button", { name: /connect substack/i }),
    );
    await waitFor(() =>
      expect(container.textContent).toContain("Session rejected")
    );
    expect(onAuthError).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("sid-secret");

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 401 }))
    ) as typeof fetch;
    await fireEvent.click(
      screen.getByRole("button", { name: /connect substack/i }),
    );
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });

  it("shows the saved paid-title preference unchecked or checked", () => {
    const unchecked = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(
      screen.getByRole("checkbox", { name: "Show paid post titles" }),
    ).not.toBeChecked();
    unchecked.unmount();

    render(() => (
      <SubstackConnectPanel
        sources={[{ ...connectedSource, showPaidPostTitles: true }]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(
      screen.getByRole("checkbox", { name: "Show paid post titles" }),
    ).toBeChecked();
  });

  it("saves the paid-title preference immediately and refreshes after success", async () => {
    const response = createDeferred<Response>();
    const onSourceUpdated = vi.fn(() => Promise.resolve());
    const requests: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push([String(input), init]);
      return response.promise;
    }) as typeof fetch;
    render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onSourceUpdated={onSourceUpdated}
        onAuthError={() => {}}
      />
    ));

    const checkbox = screen.getByRole("checkbox", {
      name: "Show paid post titles",
    });
    await fireEvent.click(checkbox);

    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toBe("/sources/source-1");
    expect(requests[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(requests[0][1]?.body as string)).toEqual({
      showPaidPostTitles: true,
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving digest preference",
    );
    expect(onSourceUpdated).not.toHaveBeenCalled();

    response.resolve(
      new Response(
        JSON.stringify({ ...connectedSource, showPaidPostTitles: true }),
        { status: 200 },
      ),
    );
    await waitFor(() => expect(onSourceUpdated).toHaveBeenCalledTimes(1));
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Digest preference saved",
    );
  });

  it("rolls back a failed paid-title change and reports authentication failures", async () => {
    const onAuthError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "UNAUTHORIZED", message: "Sign in again" },
          }),
          { status: 401 },
        ),
      )
    ) as typeof fetch;
    render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={onAuthError}
      />
    ));

    const checkbox = screen.getByRole("checkbox", {
      name: "Show paid post titles",
    });
    await fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in again");
  });

  it("only renders publication onboarding for a connected Substack source", () => {
    const disconnected = render(() => (
      <SubstackConnectPanel
        sources={[disconnectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(disconnected.container.querySelector("#substack-publication-url"))
      .toBeNull();
    disconnected.unmount();

    const connected = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(connected.container.querySelector("#substack-publication-url")).not
      .toBeNull();
  });

  it("validates publication URLs and clears the form after onboarding", async () => {
    const onPublicationAdded = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            source: connectedSource,
            feed: {
              id: "feed-1",
              sourceId: "source-1",
              externalId: "https://example.com",
              name: "Example",
              kind: "news",
            },
          }),
          { status: 201 },
        ),
      )
    ) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={onPublicationAdded}
        onAuthError={() => {}}
      />
    ));
    const url = container.querySelector<HTMLInputElement>(
      "#substack-publication-url",
    )!;
    const submit = screen.getByRole("button", { name: /add publication/i });
    await fireEvent.input(url, { target: { value: "http://example.com" } });
    await fireEvent.click(submit);
    expect(container.textContent).toContain("valid HTTPS publication URL");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await fireEvent.input(url, {
      target: { value: "https://example.com/news" },
    });
    await fireEvent.click(submit);
    await waitFor(() => expect(onPublicationAdded).toHaveBeenCalledTimes(1));
    expect(url.value).toBe("");
    expect(container.textContent).toContain("Publication added");
  });
  it("loads followed publications, scopes existing feeds, and keeps unrelated additions available", async () => {
    const onPublicationAdded = vi.fn(() => Promise.resolve());
    const calls: Array<[string, RequestInit?]> = [];
    const addResponse = createDeferred<Response>();
    globalThis.fetch = vi.fn((input, init) => {
      calls.push([String(input), init]);
      if (
        String(input) === "/connectors/substack/publications" &&
        init?.method === "POST"
      ) {
        return addResponse.promise;
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([
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
            {
              externalId: "https://other-source.substack.com",
              name: "Other source publication",
              kind: "news",
            },
          ]),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const otherSourceFeed = {
      ...existingFeed,
      id: "feed-other-source",
      sourceId: "telegram-source",
      externalId: "https://other-source.substack.com",
    };
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[existingFeed, otherSourceFeed]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={onPublicationAdded}
        onAuthError={() => {}}
      />
    ));

    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(screen.getByText("New publication")).toBeVisible()
    );
    expect(screen.getByText("already-followed.substack.com")).toBeVisible();
    expect(screen.getByRole("button", { name: "Added Already followed" }))
      .toBeDisabled();

    const newPublicationButton = screen.getByRole("button", {
      name: "Add New publication",
    });
    const otherSourceButton = screen.getByRole("button", {
      name: "Add Other source publication",
    });
    await fireEvent.click(newPublicationButton);
    await waitFor(() => expect(newPublicationButton).toBeDisabled());
    expect(otherSourceButton).not.toBeDisabled();

    addResponse.resolve(
      new Response(
        JSON.stringify({
          source: connectedSource,
          feed: {
            id: "feed-new",
            sourceId: "source-1",
            externalId: "https://new.substack.com",
          },
        }),
        { status: 201 },
      ),
    );
    await waitFor(() => expect(onPublicationAdded).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Added Already followed" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Added New publication" }))
      .toBeDisabled();
    expect(otherSourceButton).not.toBeDisabled();
    expect(calls.map(([url]) => url)).toEqual([
      "/connectors/substack/publications",
      "/connectors/substack/publications",
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      publicationUrl: "https://new.substack.com",
    });
    expect(container.textContent).toContain("New publication added.");
  });

  it("renders an explicit empty state after discovery", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("[]", { status: 200 }))
    ) as typeof fetch;
    render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(screen.getByText(/No followed publications were found/))
        .toBeVisible()
    );
  });

  it("shows safe provider errors and routes only Morning Post auth failures to auth handling", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "UPSTREAM_FAILURE",
              message: "Followed publications are unavailable",
            },
          }),
          { status: 503 },
        ),
      )
    ) as typeof fetch;
    const unavailableRender = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(unavailableRender.container.textContent).toContain(
        "Followed publications are unavailable",
      )
    );
    unavailableRender.unmount();

    const onProviderSessionError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              message: "Substack session is invalid or expired",
            },
          }),
          { status: 422 },
        ),
      )
    ) as typeof fetch;
    const providerSessionRender = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={onProviderSessionError}
      />
    ));
    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(providerSessionRender.container.textContent).toContain(
        "Substack session is invalid or expired",
      )
    );
    expect(onProviderSessionError).not.toHaveBeenCalled();
    providerSessionRender.unmount();

    const onAuthError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "AUTH_REQUIRED",
              message: "provider internals must stay hidden",
            },
          }),
          { status: 401 },
        ),
      )
    ) as typeof fetch;
    const authRender = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={onAuthError}
      />
    ));
    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(authRender.container.textContent).not.toContain(
      "provider internals",
    );
    expect(authRender.container.textContent).not.toContain(
      "Substack session has expired",
    );
  });

  it("ignores an in-flight discovery response after the session is replaced", async () => {
    const onConnected = vi.fn(() => Promise.resolve());
    const discoveryResponse = createDeferred<Response>();
    globalThis.fetch = vi.fn((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              source: connectedSource,
            }),
            { status: 200 },
          ),
        );
      }
      return discoveryResponse.promise;
    }) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={onConnected}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await fireEvent.input(
      container.querySelector<HTMLInputElement>("#substack-session-id")!,
      { target: { value: "replacement-session" } },
    );
    await fireEvent.click(
      screen.getByRole("button", { name: /replace substack session/i }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));

    discoveryResponse.resolve(
      new Response(
        JSON.stringify([
          {
            externalId: "https://old-account.substack.com",
            name: "Old account",
            kind: "news",
          },
        ]),
        { status: 200 },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Old account")).toBeNull();
    expect(screen.getByRole("button", { name: "Find followed publications" }))
      .toBeVisible();
  });

  it("keeps a new account addition busy when the previous account request settles", async () => {
    const onConnected = vi.fn(() => Promise.resolve());
    const onPublicationAdded = vi.fn(() => Promise.resolve());
    const staleAddResponse = createDeferred<Response>();
    const currentAddResponse = createDeferred<Response>();
    let publicationAddCount = 0;
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      if (path === "/connectors/substack/session") {
        return Promise.resolve(
          new Response(JSON.stringify({ source: connectedSource }), {
            status: 200,
          }),
        );
      }
      if (
        path === "/connectors/substack/publications" &&
        init?.method === "POST"
      ) {
        publicationAddCount += 1;
        return publicationAddCount === 1
          ? staleAddResponse.promise
          : currentAddResponse.promise;
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              externalId: "https://same-publication.substack.com",
              name: "Same publication",
              kind: "news",
            },
          ]),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        feeds={[]}
        onConnected={onConnected}
        onPublicationAdded={onPublicationAdded}
        onAuthError={() => {}}
      />
    ));

    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Same publication" }))
        .toBeVisible()
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Add Same publication" }),
    );

    await fireEvent.input(
      container.querySelector<HTMLInputElement>("#substack-session-id")!,
      { target: { value: "replacement-session" } },
    );
    await fireEvent.click(
      screen.getByRole("button", { name: /replace substack session/i }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    await fireEvent.click(
      screen.getByRole("button", { name: "Find followed publications" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Same publication" }))
        .toBeVisible()
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Add Same publication" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Adding Same publication" }))
        .toBeDisabled()
    );

    staleAddResponse.reject(new Error("stale account request failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "Adding Same publication" }))
      .toBeDisabled();

    currentAddResponse.resolve(
      new Response(
        JSON.stringify({
          source: connectedSource,
          feed: {
            id: "feed-current",
            sourceId: connectedSource.id,
            externalId: "https://same-publication.substack.com",
          },
        }),
        { status: 201 },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Added Same publication" }))
        .toBeDisabled()
    );
    expect(onPublicationAdded).toHaveBeenCalledTimes(1);
  });
});
