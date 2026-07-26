/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { PublicUser } from "../api/types";
import AuthPanel from "./AuthPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createDeferred<Result>() {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const owner: PublicUser = {
  id: "owner-1",
  name: "Morning Post Owner",
  systemPrompt: "",
  summaryPrompt: "",
  defaultLanguage: null,
  defaultRelevanceFilterMode: "personalized",
  relevanceThreshold: 60,
  maximumStoriesPerDigest: null,
  interestProfileVersion: 1,
  createdAt: 0,
  updatedAt: 0,
};

describe("AuthPanel", () => {
  it("shows a loading state while checking setup status", async () => {
    const status = createDeferred<Response>();
    globalThis.fetch = vi.fn(() => status.promise) as typeof fetch;
    render(() => <AuthPanel onLogin={() => {}} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking setup status…",
    );
    expect(screen.queryByLabelText("Password")).toBeNull();

    status.resolve(jsonResponse({ setupRequired: true }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeVisible());
  });

  it("shows API status errors and allows retrying setup status", async () => {
    let requestCount = 0;
    globalThis.fetch = vi.fn(() => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? jsonResponse(
              { error: { code: "UNAVAILABLE", message: "setup unavailable" } },
              503,
            )
          : jsonResponse({ setupRequired: false }),
      );
    }) as typeof fetch;
    render(() => <AuthPanel onLogin={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("setup unavailable")
    );
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeVisible());
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  it("submits first-run setup once and passes the authenticated owner to onLogin", async () => {
    const setupResponse = createDeferred<Response>();
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push({ path: String(input), init });
      if (init?.method === "POST") return setupResponse.promise;
      return Promise.resolve(jsonResponse({ setupRequired: true }));
    }) as typeof fetch;
    const onLogin = vi.fn();
    render(() => <AuthPanel onLogin={onLogin} />);
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeVisible());

    await fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Morning Post Owner" },
    });
    await fireEvent.input(screen.getByLabelText("Password"), {
      target: { value: "owner-password-123" },
    });
    const submit = screen.getByRole("button", { name: "Create owner account" });
    await fireEvent.click(submit);
    expect(submit).toBeDisabled();
    await fireEvent.click(submit);
    expect(
      requests.filter(({ path, init }) => path === "/auth/setup" && init?.method === "POST"),
    ).toHaveLength(1);

    setupResponse.resolve(jsonResponse(owner, 201));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(owner));
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });

  it("uses password-only login and displays API submit errors", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push({ path: String(input), init });
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "INVALID_PASSWORD", message: "invalid password" } },
            401,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ setupRequired: false }));
    }) as typeof fetch;
    render(() => <AuthPanel onLogin={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible());
    expect(screen.queryByLabelText("Name")).toBeNull();

    await fireEvent.input(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("invalid password")
    );
    const loginRequest = requests.find(
      ({ path, init }) => path === "/auth/login" && init?.method === "POST",
    );
    expect(loginRequest).toBeDefined();
    expect(JSON.parse(loginRequest?.init?.body as string)).toEqual({
      password: "wrong-password",
    });
  });
});
