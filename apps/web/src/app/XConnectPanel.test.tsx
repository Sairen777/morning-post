/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import XConnectPanel from "./XConnectPanel";
import type {
  PublicFeed,
  PublicSource,
  XLoginStatus,
  XLoginStatusResponse,
} from "../api/types";

const connectedXSource: PublicSource = {
  id: "source-x",
  userId: "user-1",
  connectorId: "X",
  position: null,
  enabled: true,
  showPaidPostTitles: false,
  relevanceFilterMode: "inherit",
  connected: true,
  createdAt: 0,
  updatedAt: 0,
};

const disconnectedXSource: PublicSource = {
  ...connectedXSource,
  connected: false,
  enabled: false,
};

const existingXFeed: PublicFeed = {
  id: "feed-existing",
  sourceId: connectedXSource.id,
  externalId: "x:list:123",
  name: "Morning Post list",
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

const originalFetch = globalThis.fetch;

type PanelProps = Parameters<typeof XConnectPanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    sources: [],
    feeds: [],
    onConnected: () => Promise.resolve(),
    onTargetAdded: () => Promise.resolve(),
    onAuthError: () => {},
    ...overrides,
  };
  return render(() => <XConnectPanel {...props} />);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loginStatus(
  status: XLoginStatus,
  sessionId = "session-1",
): XLoginStatusResponse {
  return {
    sessionId,
    status,
    expiresAtMs: 4_102_444_800_000,
  };
}

function createDeferred<Result>() {
  let resolvePromise!: (value: Result | PromiseLike<Result>) => void;
  const promise = new Promise<Result>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("XConnectPanel", () => {
  it("explains the channel-neutral dedicated-browser workflow, default installed-Chrome clarity, and indefinite retention before connecting", () => {
    const { container } = renderPanel();

    expect(
      screen.getByRole("heading", { name: "X Connection" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    ).toBeEnabled();
    expect(container).toHaveTextContent(
      "separate profile owned by Morning Post, not your daily browser profile",
    );
    expect(container).toHaveTextContent(
      "The default setup uses installed stable Chrome as that dedicated browser",
    );
    expect(container).toHaveTextContent(
      "never give Morning Post an X password, 2FA code, cookie, or session credential here",
    );

    const guidance = screen.getByRole("note");
    expect(guidance).toHaveTextContent(
      "same desktop where its service is running",
    );
    expect(guidance).toHaveTextContent(
      "a remote or headless server cannot display this window for you",
    );
    expect(guidance).toHaveTextContent(
      "fully close the dedicated login browser — Verify reopens the same profile to check your login",
    );
    expect(guidance).toHaveTextContent(
      "scheduled captures run headlessly from Morning Post's dedicated profile",
    );
    expect(guidance).toHaveTextContent(
      "Captured disappearing messages are retained indefinitely",
    );
    // Installed-Chrome details appear only inside conditional wording.
    expect(container).not.toHaveTextContent(
      "installed Chrome with a separate profile",
    );
    expect(container).not.toHaveTextContent("fully quit Chrome");
    // No API credential form is offered.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container).not.toHaveTextContent(/API key/i);
  });

  it("starts a dedicated browser login and makes each polled login status visible", async () => {
    vi.useFakeTimers();
    const startResponse = createDeferred<Response>();
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return startResponse.promise;
      }
      if (
        path === "/connectors/x/login/session-1" &&
        init?.method === undefined
      ) {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_chat_unlock")));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const view = renderPanel();
    const connect = screen.getByRole("button", {
      name: "Connect X with Morning Post's dedicated browser profile",
    });
    await fireEvent.click(connect);

    expect(connect).toBeDisabled();
    expect(connect).toHaveTextContent(
      "Starting Morning Post's dedicated browser profile",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/connectors/x/login");
    expect(calls[0][1]?.method).toBe("POST");
    expect(calls[0][1]?.body).toBeUndefined();
    expect(calls[0][1]?.credentials).toBe("include");

    startResponse.resolve(jsonResponse(loginStatus("awaiting_login")));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("Awaiting X login")).toBeVisible();
    const loginStatusMessage = screen.getByRole("status");
    expect(loginStatusMessage).toHaveTextContent("in the dedicated browser");
    expect(loginStatusMessage).toHaveTextContent("complete any 2FA");
    expect(loginStatusMessage).toHaveTextContent(
      "dedicated profile, not your daily browser profile",
    );
    expect(loginStatusMessage).toHaveTextContent(
      "fully close the dedicated login browser",
    );
    expect(loginStatusMessage).toHaveTextContent(
      "Verify reopens the same profile",
    );
    expect(loginStatusMessage).toHaveTextContent("Cmd-Q");
    expect(loginStatusMessage).toHaveTextContent(
      "closing a tab or window is not enough",
    );
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Verify login" }),
    ).toBeEnabled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe("/connectors/x/login/session-1");
    expect(calls[1][1]?.method).toBeUndefined();
    expect(calls[1][1]?.credentials).toBe("include");
    expect(screen.getByText("Awaiting Chat unlock")).toBeVisible();
    const chatUnlockStatusMessage = screen.getByRole("status");
    expect(chatUnlockStatusMessage).toHaveTextContent(
      "The dedicated browser is open at X Messages",
    );
    expect(chatUnlockStatusMessage).toHaveTextContent("Unlock Chat");
    expect(chatUnlockStatusMessage).toHaveTextContent(
      "fully close the dedicated login browser",
    );
    expect(chatUnlockStatusMessage).toHaveTextContent(
      "Verify reopens the same profile",
    );
    expect(chatUnlockStatusMessage).toHaveTextContent("Cmd-Q");
    expect(chatUnlockStatusMessage).toHaveTextContent(
      "closing a tab or window is not enough",
    );

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes an active dedicated browser login after the panel is remounted", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_login")));
      }
      if (
        path === "/connectors/x/login/session-1" &&
        init?.method === undefined
      ) {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_chat_unlock")));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const firstView = renderPanel();
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Awaiting X login")).toBeVisible()
    );
    expect(globalThis.sessionStorage.getItem("morning-post.x-login-session-id"))
      .toBe("session-1");
    firstView.unmount();

    const secondView = renderPanel();
    await waitFor(() =>
      expect(screen.getByText("Awaiting Chat unlock")).toBeVisible()
    );
    expect(calls.map(([path, init]) => [path, init?.method ?? "GET"]))
      .toEqual([
        ["/connectors/x/login", "POST"],
        ["/connectors/x/login/session-1", "GET"],
      ]);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    secondView.unmount();
  });

  it("forgets a restored login session that no longer exists", async () => {
    globalThis.sessionStorage.setItem(
      "morning-post.x-login-session-id",
      "stale-session",
    );
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({
        error: {
          code: "NOT_FOUND",
          message: "X login session not found",
        },
      }, 404))
    ) as typeof fetch;

    const view = renderPanel();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "The previous X login session is no longer active",
      )
    );
    expect(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    ).toBeEnabled();
    expect(globalThis.sessionStorage.getItem("morning-post.x-login-session-id"))
      .toBeNull();
    view.unmount();
  });

  it("verifies a pending login, stops polling, and refreshes connected sources once", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, RequestInit | undefined]> = [];
    const onConnected = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_login")));
      }
      if (
        path === "/connectors/x/login/session-1/verify" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(jsonResponse(loginStatus("complete")));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const view = renderPanel({ onConnected });
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(
      screen.getByRole("button", { name: "Verify login" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/connectors/x/login", "POST"],
      ["/connectors/x/login/session-1/verify", "POST"],
    ]);
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Scheduled captures will run headlessly",
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
  });

  it("shows a recovery error and keeps Verify enabled when verification returns awaiting_login", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, RequestInit | undefined]> = [];
    const recoveryError =
      "X authentication evidence could not be inspected; your dedicated Chrome profile was preserved and Chrome was reopened at X Home. Confirm the authenticated timeline is visible, fully quit Chrome (Cmd-Q on macOS), then Verify again or cancel this login.";
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_login")));
      }
      if (
        path === "/connectors/x/login/session-1/verify" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(
          jsonResponse({
            ...loginStatus("awaiting_login"),
            error: recoveryError,
          }),
        );
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const view = renderPanel();
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("Awaiting X login")).toBeVisible();

    await fireEvent.click(
      screen.getByRole("button", { name: "Verify login" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/connectors/x/login", "POST"],
      ["/connectors/x/login/session-1/verify", "POST"],
    ]);
    expect(screen.getByText("Awaiting X login")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(recoveryError);
    expect(
      screen.getByRole("button", { name: "Verify login" }),
    ).toBeEnabled();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-progress login and removes its polling status", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_login")));
      }
      if (
        path === "/connectors/x/login/session-1" &&
        init?.method === "DELETE"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const view = renderPanel();
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/connectors/x/login", "POST"],
      ["/connectors/x/login/session-1", "DELETE"],
    ]);
    expect(screen.queryByRole("heading", { name: "Connection status" }))
      .toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The X login session was canceled",
    );
    expect(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    ).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
  });

  it("propagates authentication failures from verify, cancel, and automatic polling", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, RequestInit | undefined]> = [];
    const onAuthError = vi.fn();
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(loginStatus("awaiting_login")));
      }
      return Promise.resolve(jsonResponse({
        error: { code: "UNAUTHORIZED", message: "Sign in again" },
      }, 401));
    }) as typeof fetch;

    const view = renderPanel({ onAuthError });
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    await fireEvent.click(
      screen.getByRole("button", { name: "Verify login" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthError).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthError).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onAuthError).toHaveBeenCalledTimes(3);
    expect(calls.map(([path, init]) => [
      path,
      init?.method ?? "GET",
    ])).toEqual([
      ["/connectors/x/login", "POST"],
      ["/connectors/x/login/session-1/verify", "POST"],
      ["/connectors/x/login/session-1", "DELETE"],
      ["/connectors/x/login/session-1", "GET"],
    ]);
    expect(screen.queryByRole("alert")).toBeNull();

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows target onboarding only for a connected X source", () => {
    const disconnected = renderPanel({ sources: [disconnectedXSource] });
    expect(screen.queryByLabelText("X target URL")).toBeNull();
    disconnected.unmount();

    renderPanel({ sources: [connectedXSource] });
    expect(screen.getByRole("heading", { name: "Add an X feed" })).toBeVisible();
    expect(screen.getByLabelText("X target URL")).toBeRequired();
    expect(screen.getByText("https://x.com/home")).toBeVisible();
    expect(screen.getByText(/https:\/\/x\.com\/i\/lists/)).toBeVisible();
    expect(screen.getByText(/https:\/\/x\.com\/i\/chat/)).toBeVisible();
  });

  it("discovers every safe X feed kind and adds each canonical target independently", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const existingFeed: PublicFeed = {
      ...existingXFeed,
      id: "feed-existing-chat",
      externalId: "x:chat:already_1",
      name: "Already added chat",
      kind: "discussion",
    };
    const discoveredFeeds = [
      {
        externalId: "x:following",
        name: "Following",
        kind: "news",
      },
      {
        externalId: "x:list:123",
        name: "Engineering list",
        kind: "news",
      },
      {
        externalId: "x:chat:team-room_42",
        name: "Team room",
        kind: "discussion",
      },
      {
        externalId: existingFeed.externalId,
        name: existingFeed.name,
        kind: "discussion",
      },
      {
        externalId: "x:list:0",
        name: "Zero list",
        kind: "news",
      },
      {
        externalId: "x:list:-1",
        name: "Negative list",
        kind: "news",
      },
      {
        externalId: "x:list:not-numeric",
        name: "Malformed list",
        kind: "news",
      },
      {
        externalId: "x:chat:bad/id",
        name: "Malformed chat",
        kind: "discussion",
      },
      {
        externalId: "x:chat:_leading",
        name: "Leading separator chat",
        kind: "discussion",
      },
      {
        externalId: "x:other",
        name: "Unknown X feed",
        kind: "news",
      },
    ];
    const addedByUrl: Record<string, PublicFeed> = {
      "https://x.com/home": {
        ...existingXFeed,
        id: "feed-following",
        externalId: "x:following",
        name: "Following",
      },
      "https://x.com/i/lists/123": {
        ...existingXFeed,
        id: "feed-list",
        externalId: "x:list:123",
        name: "Engineering list",
      },
      "https://x.com/i/chat/team-room_42": {
        ...existingXFeed,
        id: "feed-chat",
        externalId: "x:chat:team-room_42",
        name: "Team room",
        kind: "discussion",
      },
    };
    const onTargetAdded = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (
        path === "/sources/source-x/available-feeds" &&
        init?.method === undefined
      ) {
        return Promise.resolve(jsonResponse(discoveredFeeds));
      }
      if (path === "/connectors/x/targets" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          sourceId: string;
          url: string;
        };
        const addedFeed = addedByUrl[body.url];
        if (addedFeed) return Promise.resolve(jsonResponse(addedFeed, 201));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    renderPanel({
      sources: [connectedXSource],
      feeds: [existingFeed],
      onTargetAdded,
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Discover X feeds" }),
    );

    await waitFor(() => expect(screen.getByText("Following")).toBeVisible());
    expect(screen.getByText("Engineering list")).toBeVisible();
    expect(screen.getByText("Team room")).toBeVisible();
    expect(screen.getByText("Following · https://x.com/home")).toBeVisible();
    expect(
      screen.getByText("List · https://x.com/i/lists/123"),
    ).toBeVisible();
    expect(
      screen.getByText("Chat · https://x.com/i/chat/team-room_42"),
    ).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Added Already added chat",
    })).toBeDisabled();
    for (
      const hiddenName of [
        "Zero list",
        "Negative list",
        "Malformed list",
        "Malformed chat",
        "Leading separator chat",
        "Unknown X feed",
      ]
    ) {
      expect(screen.queryByText(hiddenName)).toBeNull();
    }

    for (const name of ["Following", "Engineering list", "Team room"]) {
      await fireEvent.click(screen.getByRole("button", { name: `Add ${name}` }));
      await waitFor(() =>
        expect(onTargetAdded).toHaveBeenCalledTimes(
          ["Following", "Engineering list", "Team room"].indexOf(name) + 1,
        )
      );
      expect(screen.getByRole("button", { name: `Add ${name}` })).toBeEnabled();
    }

    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/sources/source-x/available-feeds", undefined],
      ["/connectors/x/targets", "POST"],
      ["/connectors/x/targets", "POST"],
      ["/connectors/x/targets", "POST"],
    ]);
    expect(calls.slice(1).map(([, init]) =>
      JSON.parse(init?.body as string)
    )).toEqual([
      { sourceId: "source-x", url: "https://x.com/home" },
      { sourceId: "source-x", url: "https://x.com/i/lists/123" },
      { sourceId: "source-x", url: "https://x.com/i/chat/team-room_42" },
    ]);
  });

  it("rejects non-canonical X target URLs before making an API request", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("invalid URLs must not reach the API"))
    ) as typeof fetch;
    renderPanel({ sources: [connectedXSource] });
    const input = screen.getByLabelText("X target URL");
    const submit = screen.getByRole("button", { name: "Add X feed" });
    const invalidUrls = [
      "http://x.com/home",
      "https://www.x.com/home",
      "https://x.com/home/",
      "https://x.com/home?view=latest",
      "https://x.com/i/lists/not-numeric",
      "https://x.com/messages/chat.id",
      "https://x.com/messages/conversation_1",
      "https://x.com/i/chat/_leading",
      "https://x.com/i/chat/team.room",
      "https://x.com/i/chat/team-room#latest",
    ];

    for (const value of invalidUrls) {
      await fireEvent.input(input, { target: { value } });
      await fireEvent.click(submit);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Use one canonical URL: https://x.com/home, https://x.com/i/lists/<numeric-id>, or https://x.com/i/chat/<safe-id>.",
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("adds a canonical target through one evidence-bound connector request", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const addedFeed: PublicFeed = {
      ...existingXFeed,
      id: "feed-new",
      externalId: "x:list:456",
      name: "Engineering list",
    };
    const onTargetAdded = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/targets" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(addedFeed, 201));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    renderPanel({
      sources: [connectedXSource],
      onTargetAdded,
    });
    const input = screen.getByLabelText("X target URL") as HTMLInputElement;
    await fireEvent.input(input, {
      target: { value: "https://x.com/i/lists/456" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add X feed" }));

    await waitFor(() => expect(onTargetAdded).toHaveBeenCalledWith("source-x"));
    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/connectors/x/targets", "POST"],
    ]);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      sourceId: "source-x",
      url: "https://x.com/i/lists/456",
    });
    expect(calls[0][1]?.credentials).toBe("include");
    expect(input.value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Engineering list was added to your feeds",
    );
    expect(onTargetAdded).toHaveBeenCalledTimes(1);
  });

  it("recognizes an already-active feed returned by X target addition", async () => {
    const existingChatFeed: PublicFeed = {
      ...existingXFeed,
      id: "feed-existing-chat",
      externalId: "x:chat:conversation_1",
      name: "Project chat",
      kind: "discussion",
    };
    const calls: Array<[string, RequestInit | undefined]> = [];
    const onTargetAdded = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/x/targets" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(existingChatFeed, 201));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    renderPanel({
      sources: [connectedXSource],
      feeds: [existingChatFeed],
      onTargetAdded,
    });
    await fireEvent.input(screen.getByLabelText("X target URL"), {
      target: { value: "https://x.com/i/chat/conversation_1" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add X feed" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Project chat is already in your feeds",
      )
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      sourceId: "source-x",
      url: "https://x.com/i/chat/conversation_1",
    });
    expect(onTargetAdded).not.toHaveBeenCalled();
  });

  it("propagates Morning Post authentication errors from login and target actions", async () => {

    const onLoginAuthError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({
        error: { code: "UNAUTHORIZED", message: "Sign in again" },
      }, 401))
    ) as typeof fetch;
    const loginView = renderPanel({ onAuthError: onLoginAuthError });
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Connect X with Morning Post's dedicated browser profile",
      }),
    );
    await waitFor(() => expect(onLoginAuthError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    loginView.unmount();

    const onTargetAuthError = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({
        error: { code: "UNAUTHORIZED", message: "Sign in again" },
      }, 401))
    ) as typeof fetch;
    renderPanel({
      sources: [connectedXSource],
      onAuthError: onTargetAuthError,
    });
    await fireEvent.input(screen.getByLabelText("X target URL"), {
      target: { value: "https://x.com/home" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add X feed" }));

    await waitFor(() => expect(onTargetAuthError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
