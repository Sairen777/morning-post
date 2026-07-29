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
  storyDetailLevel: "balanced",
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
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();

    status.resolve(jsonResponse({
      setupRequired: true,
      passwordRequired: false,
    }));
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
          : jsonResponse({
              setupRequired: false,
              passwordRequired: true,
            }),
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

  it("submits name-only setup once and passes the authenticated owner to onLogin", async () => {
    const setupResponse = createDeferred<Response>();
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push({ path: String(input), init });
      if (init?.method === "POST") return setupResponse.promise;
      return Promise.resolve(jsonResponse({
        setupRequired: true,
        passwordRequired: false,
      }));
    }) as typeof fetch;
    const onLogin = vi.fn();
    render(() => <AuthPanel onLogin={onLogin} />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Welcome to Morning Post" }),
      ).toBeVisible()
    );

    expect(
      screen.getByText("Choose the name shown in your digests."),
    ).toBeVisible();
    expect(screen.queryByText(/account/i)).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toBeRequired();
    await fireEvent.input(nameInput, {
      target: { value: "Morning Post Owner" },
    });

    const submit = screen.getByRole("button", { name: "Get started" });
    await fireEvent.click(submit);
    expect(submit).toBeDisabled();
    await fireEvent.click(submit);

    const setupRequests = requests.filter(
      ({ path, init }) =>
        path === "/auth/setup" && init?.method === "POST",
    );
    expect(setupRequests).toHaveLength(1);
    expect(JSON.parse(setupRequests[0].init?.body as string)).toEqual({
      name: "Morning Post Owner",
    });

    setupResponse.resolve(jsonResponse(owner, 201));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(owner));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("continues a passwordless owner with no fields or credentials", async () => {
    const loginResponse = createDeferred<Response>();
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push({ path: String(input), init });
      if (init?.method === "POST") return loginResponse.promise;
      return Promise.resolve(jsonResponse({
        setupRequired: false,
        passwordRequired: false,
      }));
    }) as typeof fetch;
    const onLogin = vi.fn();
    render(() => <AuthPanel onLogin={onLogin} />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Welcome back" }),
      ).toBeVisible()
    );

    expect(screen.getByText("Continue to your Morning Post.")).toBeVisible();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    const submit = screen.getByRole("button", { name: "Continue" });
    await fireEvent.click(submit);
    expect(submit).toBeDisabled();
    await fireEvent.click(submit);

    const loginRequests = requests.filter(
      ({ path, init }) =>
        path === "/auth/login" && init?.method === "POST",
    );
    expect(loginRequests).toHaveLength(1);
    expect(JSON.parse(loginRequests[0].init?.body as string)).toEqual({});

    loginResponse.resolve(jsonResponse(owner));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(owner));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("signs in a password-backed owner with only the password", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn((input, init) => {
      requests.push({ path: String(input), init });
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(owner));
      }
      return Promise.resolve(jsonResponse({
        setupRequired: false,
        passwordRequired: true,
      }));
    }) as typeof fetch;
    const onLogin = vi.fn();
    render(() => <AuthPanel onLogin={onLogin} />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Sign in" }),
      ).toBeVisible()
    );

    expect(screen.queryByLabelText("Name")).toBeNull();
    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toBeRequired();
    await fireEvent.input(passwordInput, {
      target: { value: "owner-password-123" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(owner));
    expect(onLogin).toHaveBeenCalledTimes(1);
    const loginRequest = requests.find(
      ({ path, init }) =>
        path === "/auth/login" && init?.method === "POST",
    );
    expect(loginRequest).toBeDefined();
    expect(JSON.parse(loginRequest?.init?.body as string)).toEqual({
      password: "owner-password-123",
    });
  });

  it("displays password sign-in API errors", async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "INVALID_PASSWORD", message: "invalid password" } },
            401,
          ),
        );
      }
      return Promise.resolve(jsonResponse({
        setupRequired: false,
        passwordRequired: true,
      }));
    }) as typeof fetch;
    render(() => <AuthPanel onLogin={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeVisible());

    await fireEvent.input(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("invalid password")
    );
  });
});
