/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import XConnectPanel from "./XConnectPanel";
import type { PublicSource } from "../api/types";

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

const originalFetch = globalThis.fetch;

type PanelProps = Parameters<typeof XConnectPanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    sources: [],
    onConnected: () => Promise.resolve(),
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

function sessionResponse(): Response {
  return jsonResponse({
    source: {
      id: "source-x",
      connectorId: "X",
      connected: true,
    },
  });
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

function fillSecrets(
  apiKey = "twex-key",
  authToken = "auth-token",
  cookie = "auth_token=auth-token; ct0=csrf-token; lang=en",
) {
  fireEvent.input(screen.getByLabelText("TwexAPI key"), {
    target: { value: apiKey },
  });
  fireEvent.input(screen.getByLabelText("X auth_token"), {
    target: { value: authToken },
  });
  fireEvent.input(screen.getByLabelText("Complete X Cookie header value"), {
    target: { value: cookie },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("XConnectPanel", () => {
  it("renders the TwexAPI credential form with required password secrets and distinguishing helper text", () => {
    const { container } = renderPanel();

    expect(
      screen.getByRole("heading", { name: "Connect X with TwexAPI" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect X" }),
    ).toBeEnabled();
    expect(container).toHaveTextContent(
      "Enter a TwexAPI key, the X auth_token for account validation",
    );
    expect(container).toHaveTextContent(
      "never displays them after a successful connection",
    );

    const guidance = screen.getByRole("note");
    expect(guidance).toHaveTextContent(
      "Keep the auth_token separate because it is used to validate your account",
    );
    expect(guidance).toHaveTextContent(
      "do not enter your X password or a 2FA code",
    );
    expect(guidance).toHaveTextContent(
      "complete X Cookie header value for XChat, including matching auth_token and non-empty ct0 cookie pairs",
    );
    expect(guidance).toHaveTextContent(
      "An XChat PIN is optional. Leave it blank to use TwexAPI's default 1234",
    );
    expect(guidance).toHaveTextContent(
      "sent only when reading group message history, not when discovering conversations",
    );
    expect(guidance).toHaveTextContent(
      "Leave the list-search query blank to search with your connected X username",
    );

    const apiKey = screen.getByLabelText("TwexAPI key") as HTMLInputElement;
    const authToken = screen.getByLabelText("X auth_token") as HTMLInputElement;
    const cookie = screen.getByLabelText(
      "Complete X Cookie header value",
    ) as HTMLInputElement;
    const pin = screen.getByLabelText("XChat PIN (optional)") as HTMLInputElement;
    const listQuery = screen.getByLabelText(
      "List-search query (optional)",
    ) as HTMLInputElement;

    expect(apiKey.type).toBe("password");
    expect(apiKey).toBeRequired();
    expect(apiKey).toHaveAttribute("autocomplete", "off");
    expect(apiKey).toHaveAccessibleDescription("The API key issued by TwexAPI.");

    expect(authToken.type).toBe("password");
    expect(authToken).toBeRequired();
    expect(authToken).toHaveAccessibleDescription(
      "Copy the auth_token value from your X cookie.",
    );

    expect(cookie.type).toBe("password");
    expect(cookie).toBeRequired();
    expect(cookie).toHaveAttribute("maxlength", "16384");
    expect(cookie).toHaveAccessibleDescription(
      "Paste the complete Cookie header value from X, including the auth_token value that matches the field above and a non-empty ct0. This is required for XChat.",
    );

    expect(pin.type).toBe("password");
    expect(pin).not.toBeRequired();
    expect(pin).toHaveAccessibleDescription(
      "Optional for message history. Leave blank to use TwexAPI's default PIN, 1234; conversation discovery does not use it.",
    );

    expect(listQuery.type).toBe("text");
    expect(listQuery).not.toBeRequired();
    expect(listQuery).toHaveAccessibleDescription(
      "Search text for Lists. Blank uses the connected X username.",
    );
  });

  it("offers reconnect and the connected status only when an X source exists", () => {
    const none = renderPanel();
    expect(
      screen.getByRole("button", { name: "Connect X" }),
    ).toBeEnabled();
    expect(screen.queryByText(/X is connected/)).toBeNull();
    none.unmount();

    const disconnected = renderPanel({ sources: [disconnectedXSource] });
    expect(
      screen.getByRole("button", { name: "Reconnect X" }),
    ).toBeEnabled();
    expect(screen.queryByText(/X is connected/)).toBeNull();
    disconnected.unmount();

    renderPanel({ sources: [connectedXSource] });
    expect(
      screen.getByRole("button", { name: "Reconnect X" }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "X is connected. Use Sources to discover and subscribe to Lists and XChat groups.",
      ),
    ).toBeVisible();
  });

  it("requires the complete cookie header before making any request", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("cookie validation must happen client-side"))
    ) as typeof fetch;
    renderPanel();

    fillSecrets();
    fireEvent.input(screen.getByLabelText("Complete X Cookie header value"), {
      target: { value: "   " },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Complete X Cookie header value is required.",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("submits exactly the trimmed API key, auth token, and full cookie to the session route", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      calls.push([String(input), init]);
      return Promise.resolve(sessionResponse());
    }) as typeof fetch;
    const onConnected = vi.fn(() => Promise.resolve());
    renderPanel({ onConnected });

    fillSecrets("  twex-key  ", " auth-token ", "auth_token=auth-token; ct0=csrf-token");
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/connectors/x/session");
    expect(calls[0][1]?.method).toBe("POST");
    expect(calls[0][1]?.credentials).toBe("include");
    expect(calls[0][1]?.headers).toEqual({
      "content-type": "application/json",
    });
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      apiKey: "twex-key",
      authToken: "auth-token",
      cookie: "auth_token=auth-token; ct0=csrf-token",
    });
  });

  it("includes the optional PIN and list query only when filled in", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      calls.push([String(input), init]);
      return Promise.resolve(sessionResponse());
    }) as typeof fetch;
    const onConnected = vi.fn(() => Promise.resolve());
    renderPanel({ onConnected });

    fillSecrets();
    fireEvent.input(screen.getByLabelText("XChat PIN (optional)"), {
      target: { value: "1234" },
    });
    fireEvent.input(screen.getByLabelText("List-search query (optional)"), {
      target: { value: " machine learning " },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      apiKey: "twex-key",
      authToken: "auth-token",
      cookie: "auth_token=auth-token; ct0=csrf-token; lang=en",
      pin: "1234",
      listQuery: "machine learning",
    });
  });

  it("clears every secret on success, reports success, and retains the list query", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionResponse())) as typeof fetch;
    const onConnected = vi.fn(() => Promise.resolve());
    renderPanel({ onConnected });

    fillSecrets();
    fireEvent.input(screen.getByLabelText("XChat PIN (optional)"), {
      target: { value: "1234" },
    });
    fireEvent.input(screen.getByLabelText("List-search query (optional)"), {
      target: { value: "machine learning" },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "X is connected. Your credentials are encrypted at rest; discover Lists and XChat groups in Sources.",
        ),
      ).toBeVisible()
    );
    expect(onConnected).toHaveBeenCalledTimes(1);

    for (const label of [
      "TwexAPI key",
      "X auth_token",
      "Complete X Cookie header value",
      "XChat PIN (optional)",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
    expect(
      (screen.getByLabelText("List-search query (optional)") as HTMLInputElement)
        .value,
    ).toBe("machine learning");
    expect(
      screen.getByRole("button", { name: "Connect X" }),
    ).toBeEnabled();
  });

  it("clears secrets on a successful reconnect of an existing X source", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionResponse())) as typeof fetch;
    const onConnected = vi.fn(() => Promise.resolve());
    renderPanel({ sources: [connectedXSource], onConnected });

    fillSecrets("new-key", "new-token", "auth_token=new-token; ct0=new-ct0");
    await fireEvent.click(
      screen.getByRole("button", { name: "Reconnect X" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "X is connected. Your credentials are encrypted at rest; discover Lists and XChat groups in Sources.",
        ),
      ).toBeVisible()
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("TwexAPI key") as HTMLInputElement).value)
      .toBe("");
    expect(
      (screen.getByLabelText("Complete X Cookie header value") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("disables the form while connecting and ignores repeated submits", async () => {
    const pending = createDeferred<Response>();
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      calls.push([String(input), init]);
      return pending.promise;
    }) as typeof fetch;
    const { container } = renderPanel();

    fillSecrets();
    const submit = screen.getByRole("button", { name: "Connect X" });
    await fireEvent.click(submit);
    await fireEvent.click(submit);

    expect(container.querySelector(".card")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Connecting…" }),
    ).toBeDisabled();
    for (const label of [
      "TwexAPI key",
      "X auth_token",
      "Complete X Cookie header value",
      "XChat PIN (optional)",
      "List-search query (optional)",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(calls).toHaveLength(1);

    pending.resolve(sessionResponse());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect X" }),
      ).toBeEnabled()
    );
    expect(container.querySelector(".card")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps credentials and shows the API error message when the session request fails", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: "TWEX_SESSION_FAILED",
              message: "X credential check failed",
            },
          },
          500,
        ),
      )
    ) as typeof fetch;
    const onConnected = vi.fn(() => Promise.resolve());
    renderPanel({ onConnected });

    fillSecrets();
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "X credential check failed",
      )
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect((screen.getByLabelText("TwexAPI key") as HTMLInputElement).value)
      .toBe("twex-key");
    expect(
      (screen.getByLabelText("Complete X Cookie header value") as HTMLInputElement)
        .value,
    ).toBe("auth_token=auth-token; ct0=csrf-token; lang=en");
    expect(
      screen.getByRole("button", { name: "Connect X" }),
    ).toBeEnabled();
  });

  it("falls back to a generic error when the failure is not an API error", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network down"))
    ) as typeof fetch;
    renderPanel();

    fillSecrets();
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "X could not be connected. Check the credentials and try again.",
      )
    );
  });

  it("routes a 401 session response to the auth error handler without an alert", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: { code: "UNAUTHORIZED", message: "Sign in again" },
          },
          401,
        ),
      )
    ) as typeof fetch;
    const onAuthError = vi.fn();
    renderPanel({ onAuthError });

    fillSecrets();
    await fireEvent.click(
      screen.getByRole("button", { name: "Connect X" }),
    );

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect X" }),
    ).toBeEnabled();
  });
});
