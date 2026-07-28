/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import TelegramConnectPanel from "./TelegramConnectPanel";

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn((url: string) => Promise.resolve(`image:${url}`)),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL },
}));

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<Result>() {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderPanel(onConnected = vi.fn(() => Promise.resolve())) {
  const view = render(() => (
    <TelegramConnectPanel
      sources={[]}
      onConnected={onConnected}
      onAuthError={() => {}}
    />
  ));
  return { ...view, onConnected };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  toDataURL.mockClear();
});

describe("TelegramConnectPanel regeneration", () => {
  it("replaces the displayed QR and link, then restarts polling for the fresh session", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn((input, init) => {
      const path = String(input);
      calls.push([path, init]);
      if (path === "/connectors/telegram/login") {
        return Promise.resolve(jsonResponse({
          loginSessionId: "old-session",
          qrUrl: "tg://old",
          expiresAt: 1000,
        }));
      }
      if (path === "/connectors/telegram/login/old-session/regenerate") {
        return Promise.resolve(jsonResponse({
          loginSessionId: "new-session",
          qrUrl: "tg://new",
          expiresAt: 2000,
        }));
      }
      if (path === "/connectors/telegram/login/new-session") {
        return Promise.resolve(jsonResponse({
          status: "pending",
          qrUrl: "tg://rotated",
          expiresAt: 3000,
        }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const view = renderPanel();
    await fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("img", { name: "Telegram login QR code" }))
      .toHaveAttribute("src", "image:tg://old");

    await fireEvent.click(
      screen.getByRole("button", { name: "Regenerate QR code and link" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(calls[1][0]).toBe(
      "/connectors/telegram/login/old-session/regenerate",
    );
    expect(calls[1][1]?.method).toBe("POST");
    expect(screen.getByRole("img", { name: "Telegram login QR code" }))
      .toHaveAttribute("src", "image:tg://new");
    expect(screen.getByRole("link", { name: "Open Telegram" }))
      .toHaveAttribute("href", "tg://new");

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(calls[2][0]).toBe(
      "/connectors/telegram/login/new-session",
    ));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Telegram login QR code" }))
        .toHaveAttribute("src", "image:tg://rotated")
    );
    expect(screen.getByRole("link", { name: "Open Telegram" }))
      .toHaveAttribute("href", "tg://rotated");
    view.unmount();
  });

  it("does not let an old in-flight poll overwrite a regenerated session", async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<Response>();
    globalThis.fetch = vi.fn((input) => {
      const path = String(input);
      if (path === "/connectors/telegram/login") {
        return Promise.resolve(jsonResponse({
          loginSessionId: "old-session",
          qrUrl: "tg://old",
          expiresAt: 1000,
        }));
      }
      if (path === "/connectors/telegram/login/old-session") {
        return oldPoll.promise;
      }
      if (path === "/connectors/telegram/login/old-session/regenerate") {
        return Promise.resolve(jsonResponse({
          loginSessionId: "new-session",
          qrUrl: "tg://new",
          expiresAt: 2000,
        }));
      }
      if (path === "/connectors/telegram/login/new-session") {
        return Promise.resolve(jsonResponse({ status: "pending", expiresAt: 2000 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    const { onConnected, unmount } = renderPanel();
    await fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));
    await vi.advanceTimersByTimeAsync(2000);
    await fireEvent.click(
      screen.getByRole("button", { name: "Regenerate QR code and link" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    oldPoll.resolve(jsonResponse({
      status: "complete",
      qrUrl: "tg://stale",
      expiresAt: 1000,
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByRole("img", { name: "Telegram login QR code" }))
      .toHaveAttribute("src", "image:tg://new");
    expect(screen.getByRole("link", { name: "Open Telegram" }))
      .toHaveAttribute("href", "tg://new");
    expect(onConnected).not.toHaveBeenCalled();
    unmount();
  });
});
