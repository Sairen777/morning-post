/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import SubstackConnectPanel from "./SubstackConnectPanel";
import type { PublicSource } from "../api/types";

const connectedSource: PublicSource = {
  id: "source-1",
  userId: "user-1",
  connectorId: "Substack",
  position: null,
  enabled: true,
  connected: true,
  createdAt: 0,
  updatedAt: 0,
};

const disconnectedSource: PublicSource = { ...connectedSource, connected: false, enabled: false };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("SubstackConnectPanel", () => {
  it("discloses the unsupported full-account credential flow without rendering a raw Cookie field", () => {
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
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
    const sid = container.querySelector<HTMLInputElement>("#substack-session-id");
    expect(sid?.type).toBe("password");
    expect(sid?.getAttribute("autocomplete")).toBe("off");
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("reveals optional connect.sid, clears both values after success, and refreshes", async () => {
    const onConnected = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      source: connectedSource,
    }), { status: 200 }))) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        onConnected={onConnected}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    await fireEvent.click(container.querySelectorAll("summary")[1]);
    const connectSid = container.querySelector<HTMLInputElement>("#connect-session-id");
    expect(connectSid).not.toBeNull();
    const sid = container.querySelector<HTMLInputElement>("#substack-session-id")!;
    await fireEvent.input(sid, { target: { value: "sid-secret" } });
    await fireEvent.input(connectSid!, { target: { value: "connect-secret" } });
    await fireEvent.click(screen.getByRole("button", { name: /save session|connect substack/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(sid.value).toBe("");
    expect(connectSid!.value).toBe("");
    expect(container.textContent).toContain("connected");
    expect(container.textContent).not.toContain("sid-secret");
    expect(container.textContent).not.toContain("connect-secret");
  });

  it("sends Morning Post auth failures to the callback and keeps safe upstream errors", async () => {
    const onAuthError = vi.fn();
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: "SESSION_INVALID", message: "Session rejected" },
    }), { status: 422 }))) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={onAuthError}
      />
    ));
    const sid = container.querySelector<HTMLInputElement>("#substack-session-id")!;
    await fireEvent.input(sid, { target: { value: "sid-secret" } });
    await fireEvent.click(screen.getByRole("button", { name: /connect substack/i }));
    await waitFor(() => expect(container.textContent).toContain("Session rejected"));
    expect(onAuthError).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("sid-secret");

    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 401 }))) as typeof fetch;
    await fireEvent.click(screen.getByRole("button", { name: /connect substack/i }));
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });

  it("only renders publication onboarding for a connected Substack source", () => {
    const disconnected = render(() => (
      <SubstackConnectPanel
        sources={[disconnectedSource]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(disconnected.container.querySelector("#substack-publication-url")).toBeNull();
    disconnected.unmount();

    const connected = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(connected.container.querySelector("#substack-publication-url")).not.toBeNull();
  });

  it("validates publication URLs and clears the form after onboarding", async () => {
    const onPublicationAdded = vi.fn(() => Promise.resolve());
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      source: connectedSource,
      feed: { id: "feed-1", sourceId: "source-1", externalId: "https://example.com", name: "Example", kind: "news" },
    }), { status: 201 }))) as typeof fetch;
    const { container } = render(() => (
      <SubstackConnectPanel
        sources={[connectedSource]}
        onConnected={() => Promise.resolve()}
        onPublicationAdded={onPublicationAdded}
        onAuthError={() => {}}
      />
    ));
    const url = container.querySelector<HTMLInputElement>("#substack-publication-url")!;
    const submit = screen.getByRole("button", { name: /add publication/i });
    await fireEvent.input(url, { target: { value: "http://example.com" } });
    await fireEvent.click(submit);
    expect(container.textContent).toContain("valid HTTPS publication URL");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await fireEvent.input(url, { target: { value: "https://example.com/news" } });
    await fireEvent.click(submit);
    await waitFor(() => expect(onPublicationAdded).toHaveBeenCalledTimes(1));
    expect(url.value).toBe("");
    expect(container.textContent).toContain("Publication added");
  });
});
