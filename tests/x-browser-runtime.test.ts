import { test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";

import type { XChromeProcess } from "../src/connectors/x/chrome-process.ts";
import type {
  XBrowserSessions,
  XOwnedBrowserSession,
  XUnmanagedBrowserSession,
} from "../src/connectors/x/browser-session.ts";
import { throwIfAborted } from "../src/connectors/x/abort.ts";
import {
  HeadedLoginHandle,
  UnmanagedLoginHandle,
  XBrowserRuntime,
  XVerificationRecoveryError,
} from "../src/connectors/x/runtime.ts";
import type { XBrowserChannel, XLoginState } from "../src/connectors/x/x.types.ts";
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "./assertions.ts";

const PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";

type FakeOwnedSession = XOwnedBrowserSession & {
  readonly closeCalls: number;
};

function fakeUnmanagedSession(
  running: boolean,
  close: () => Promise<void> = async () => {},
): XUnmanagedBrowserSession {
  return {
    running,
    async waitForExit() {},
    close,
  };
}

function fakeOwnedSession(pageUrl: string): FakeOwnedSession {
  let closed = false;
  let closeCalls = 0;
  return {
    context: {
      isClosed: () => closed,
    } as BrowserContext,
    page: { url: () => pageUrl } as Page,
    async close() {
      if (closed) return;
      closed = true;
      closeCalls += 1;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

function fixture({
  running = false,
  inspections = ["complete"],
  pageUrls = ["https://x.com/home"],
  headedLaunchErrors = [],
  initialClose = async () => {},
}: {
  running?: boolean;
  inspections?: Array<XLoginState | Error>;
  pageUrls?: string[];
  headedLaunchErrors?: Error[];
  initialClose?: () => Promise<void>;
} = {}) {
  const headed: FakeOwnedSession[] = [];
  const opens: Array<{ profileId: string; signal: AbortSignal | undefined }> = [];
  let inspectionCalls = 0;
  let launchCalls = 0;
  const sessions = {
    async openHeaded(profileId: string, signal?: AbortSignal) {
      opens.push({ profileId, signal });
      const launchError = headedLaunchErrors[launchCalls];
      const pageUrl = pageUrls[Math.min(launchCalls, pageUrls.length - 1)];
      launchCalls += 1;
      if (launchError !== undefined) throw launchError;
      const session = fakeOwnedSession(pageUrl);
      headed.push(session);
      return session;
    },
  } as Pick<XBrowserSessions, "openHeaded">;
  const lifecycle = new AbortController();
  const initial = fakeUnmanagedSession(running, initialClose);
  const handle = new UnmanagedLoginHandle(
    sessions,
    PROFILE_ID,
    initial,
    lifecycle.signal,
    async () => {
      const result = inspections[Math.min(inspectionCalls, inspections.length - 1)];
      inspectionCalls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  );
  return {
    handle,
    headed,
    initial,
    lifecycle,
    opens,
    inspections: () => inspectionCalls,
  };
}

test("running unmanaged login verify neither inspects nor opens visible Chrome", async () => {
  const subject = fixture({ running: true });
  assertStrictEquals(await subject.handle.verify(), "awaiting_login");
  assertStrictEquals(subject.inspections(), 0);
  assertEquals(subject.opens, []);

  const controller = new AbortController();
  controller.abort(new Error("verify cancelled"));
  await assertRejects(() => subject.handle.verify(controller.signal), Error, "verify cancelled");
});

test("complete inspection uses one headed context and closes it", async () => {
  const subject = fixture();

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 1);
  assertEquals(subject.opens, [
    { profileId: PROFILE_ID, signal: subject.lifecycle.signal },
  ]);
  assertStrictEquals(subject.headed.length, 1);
  assertStrictEquals(subject.headed[0].context.isClosed(), true);
  assertStrictEquals(subject.headed[0].closeCalls, 1);
});

test("both nonterminal inspections keep their headed context visible", async () => {
  for (const state of ["awaiting_login", "awaiting_chat_unlock"] as const) {
    const subject = fixture({ inspections: [state] });

    assertStrictEquals(await subject.handle.verify(), state);
    assertStrictEquals(subject.inspections(), 1);
    assertStrictEquals(subject.headed.length, 1);
    assertStrictEquals(subject.headed[0].context.isClosed(), false);

    assertStrictEquals(await subject.handle.verify(), state);
    assertStrictEquals(subject.inspections(), 1);
    assertStrictEquals(subject.headed.length, 1);
  }
});

test("Home and X Chat inspection failures expose typed recovery and keep visible Chrome open", async () => {
  for (const [pageUrl, control, state] of [
    ["https://x.com/home", "home", "awaiting_login"],
    ["https://x.com/i/chat/123", "messages", "awaiting_chat_unlock"],
    ["https://x.com/i/chat", "messages", "awaiting_chat_unlock"],
  ] as const) {
    const subject = fixture({
      inspections: [new Error("X state was not inspectable")],
      pageUrls: [pageUrl],
    });

    const error = await assertRejects(
      () => subject.handle.verify(),
      XVerificationRecoveryError,
      "X verification requires manual recovery",
    );
    assertStrictEquals((error as XVerificationRecoveryError).control, control);
    assertStrictEquals(subject.inspections(), 1);
    assertStrictEquals(subject.headed.length, 1);
    assertStrictEquals(subject.headed[0].context.isClosed(), false);

    assertStrictEquals(await subject.handle.verify(), state);
    assertStrictEquals(subject.inspections(), 1);
    assertStrictEquals(subject.headed.length, 1);
  }
});

test("closing visible Chrome allows Verify to open and inspect a new headed context", async () => {
  const subject = fixture({
    inspections: ["awaiting_login", "complete"],
  });

  assertStrictEquals(await subject.handle.verify(), "awaiting_login");
  const first = subject.headed[0];
  await first.close();
  assertStrictEquals(first.context.isClosed(), true);

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 2);
  assertStrictEquals(subject.headed.length, 2);
  assertStrictEquals(subject.headed[1].context.isClosed(), true);
  assertStrictEquals(subject.headed[1].closeCalls, 1);
});

test("a failed headed launch is untyped and can be retried", async () => {
  const subject = fixture({
    headedLaunchErrors: [new Error("headed Chrome launch failed")],
  });

  const error = await assertRejects(
    () => subject.handle.verify(),
    Error,
    "headed Chrome launch failed",
  );
  assertStrictEquals(error instanceof XVerificationRecoveryError, false);
  assertStrictEquals(subject.inspections(), 0);
  assertStrictEquals(subject.opens.length, 1);
  assertStrictEquals(subject.headed.length, 0);

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 1);
  assertStrictEquals(subject.opens.length, 2);
  assertStrictEquals(subject.headed.length, 1);
  assertStrictEquals(subject.headed[0].context.isClosed(), true);
});

test("unmanaged login close is idempotent and closes the active visible context", async () => {
  let initialCloseCalls = 0;
  const subject = fixture({
    inspections: ["awaiting_login"],
    initialClose: async () => {
      initialCloseCalls += 1;
    },
  });
  assertStrictEquals(await subject.handle.verify(), "awaiting_login");
  const visible = subject.headed[0];

  await subject.handle.close();
  await subject.handle.close();

  assertStrictEquals(initialCloseCalls, 1);
  assertStrictEquals(visible.context.isClosed(), true);
  assertStrictEquals(visible.closeCalls, 1);
});

test("a failed unmanaged close can be retried and only then becomes terminal", async () => {
  let closeCalls = 0;
  const subject = fixture({
    inspections: ["awaiting_login", "complete"],
    initialClose: async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("terminate failed");
    },
  });
  assertStrictEquals(await subject.handle.verify(), "awaiting_login");

  await assertRejects(() => subject.handle.close(), Error, "terminate failed");
  assertStrictEquals(closeCalls, 1);
  // A failed close does not terminate the handle: Verify still works.
  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 2);

  await subject.handle.close();
  assertStrictEquals(closeCalls, 2);
  await assertRejects(
    () => subject.handle.verify(),
    Error,
    "X headed login session is closed",
  );
});

test("concurrent unmanaged closes share one close operation", async () => {
  let closeCalls = 0;
  const subject = fixture({
    initialClose: async () => {
      closeCalls += 1;
    },
  });

  await Promise.all([subject.handle.close(), subject.handle.close()]);

  assertStrictEquals(closeCalls, 1);
  await assertRejects(
    () => subject.handle.verify(),
    Error,
    "X headed login session is closed",
  );
});

function headedFixture({
  inspections = ["awaiting_login"],
  pageUrls = ["https://x.com/home"],
  headedLaunchErrors = [],
  initialContextClosed = false,
}: {
  inspections?: Array<XLoginState | Error>;
  pageUrls?: string[];
  headedLaunchErrors?: Error[];
  initialContextClosed?: boolean;
} = {}) {
  const headed: FakeOwnedSession[] = [];
  const opens: Array<{ profileId: string; signal: AbortSignal | undefined }> = [];
  let inspectionCalls = 0;
  let launchCalls = 0;
  const sessions = {
    async openHeaded(profileId: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      opens.push({ profileId, signal });
      const launchError = headedLaunchErrors[launchCalls];
      const pageUrl = pageUrls[Math.min(launchCalls, pageUrls.length - 1)];
      launchCalls += 1;
      if (launchError !== undefined) throw launchError;
      const session = fakeOwnedSession(pageUrl);
      headed.push(session);
      return session;
    },
  } as Pick<XBrowserSessions, "openHeaded">;
  const initial = fakeOwnedSession("https://x.com/home");
  if (initialContextClosed) {
    void initial.close();
  }
  const handle = new HeadedLoginHandle(
    initial,
    sessions,
    PROFILE_ID,
    async (page, signal) => {
      throwIfAborted(signal);
      const result = inspections[Math.min(inspectionCalls, inspections.length - 1)];
      inspectionCalls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  );
  return {
    handle,
    headed,
    initial,
    opens,
    inspections: () => inspectionCalls,
  };
}

test("managed headed login verifies the open context without reopening", async () => {
  const subject = headedFixture({ inspections: ["awaiting_login"] });

  assertStrictEquals(await subject.handle.verify(), "awaiting_login");
  assertStrictEquals(subject.inspections(), 1);
  assertEquals(subject.opens, []);
  assertStrictEquals(subject.headed.length, 0);
  assertStrictEquals(subject.initial.context.isClosed(), false);
});

test("managed headed login reopens the same profile when its context was closed before Verify", async () => {
  const subject = headedFixture({
    inspections: ["awaiting_login", "complete"],
  });

  assertStrictEquals(await subject.handle.verify(), "awaiting_login");
  assertStrictEquals(subject.opens.length, 0);

  // The user closes the managed browser window before choosing Verify.
  await subject.initial.close();
  assertStrictEquals(subject.initial.context.isClosed(), true);

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 2);
  assertEquals(subject.opens, [
    { profileId: PROFILE_ID, signal: undefined },
  ]);
  assertStrictEquals(subject.headed.length, 1);
  const reopened = subject.headed[0];
  assertStrictEquals(reopened.context.isClosed(), false);
  assertStrictEquals(reopened.closeCalls, 0);
  // The handle never touches the closed initial context again.
  assertStrictEquals(subject.initial.closeCalls, 1);
});

test("managed headed login reopened at the first Verify reaches complete", async () => {
  const subject = headedFixture({
    initialContextClosed: true,
    inspections: ["complete"],
  });

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 1);
  assertEquals(subject.opens, [
    { profileId: PROFILE_ID, signal: undefined },
  ]);
  assertStrictEquals(subject.headed.length, 1);
  assertStrictEquals(subject.headed[0].context.isClosed(), false);
});

test("cancellation blocks managed headed login Verify without inspecting", async () => {
  const subject = headedFixture({ inspections: ["complete"] });
  const controller = new AbortController();
  controller.abort(new Error("verify cancelled"));

  await assertRejects(
    () => subject.handle.verify(controller.signal),
    Error,
    "verify cancelled",
  );
  assertStrictEquals(subject.inspections(), 0);
  assertEquals(subject.opens, []);

  // An aborted reopen attempt also stops before any inspection or launch.
  await subject.initial.close();
  await assertRejects(
    () => subject.handle.verify(controller.signal),
    Error,
    "verify cancelled",
  );
  assertStrictEquals(subject.inspections(), 0);
  assertEquals(subject.opens, []);
});

test("a managed inspection failure closes only its context and leaves Verify retryable", async () => {
  const subject = headedFixture({
    inspections: [new Error("inspection failed"), "complete"],
  });

  await assertRejects(
    () => subject.handle.verify(),
    Error,
    "inspection failed",
  );
  assertStrictEquals(subject.initial.context.isClosed(), true);
  assertStrictEquals(subject.initial.closeCalls, 1);

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 2);
  assertStrictEquals(subject.opens.length, 1);
  assertStrictEquals(subject.headed.length, 1);
});

test("a failed managed reopen leaves Verify retryable", async () => {
  const subject = headedFixture({
    initialContextClosed: true,
    headedLaunchErrors: [new Error("headed Chromium launch failed")],
    inspections: ["complete"],
  });

  const error = await assertRejects(
    () => subject.handle.verify(),
    Error,
    "headed Chromium launch failed",
  );
  assertStrictEquals(error instanceof XVerificationRecoveryError, false);
  assertStrictEquals(subject.inspections(), 0);
  assertStrictEquals(subject.opens.length, 1);
  assertStrictEquals(subject.headed.length, 0);

  assertStrictEquals(await subject.handle.verify(), "complete");
  assertStrictEquals(subject.inspections(), 1);
  assertEquals(subject.opens, [
    { profileId: PROFILE_ID, signal: undefined },
    { profileId: PROFILE_ID, signal: undefined },
  ]);
  assertStrictEquals(subject.headed.length, 1);
});

test("managed headed login close is idempotent and failed closes stay retryable", async () => {
  let closeAttempts = 0;
  const failingSession: XOwnedBrowserSession = {
    context: { isClosed: () => false } as BrowserContext,
    page: { url: () => "https://x.com/home" } as Page,
    async close() {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("close failed");
    },
  };
  const sessions = {
    async openHeaded() {
      throw new Error("unexpected reopen");
    },
  } as Pick<XBrowserSessions, "openHeaded">;
  const handle = new HeadedLoginHandle(failingSession, sessions, PROFILE_ID);

  await assertRejects(() => handle.close(), Error, "close failed");
  assertStrictEquals(closeAttempts, 1);
  await handle.close();
  assertStrictEquals(closeAttempts, 2);
  await handle.close();
  assertStrictEquals(closeAttempts, 2);
  await assertRejects(
    () => handle.verify(),
    Error,
    "X headed login session is closed",
  );
});

test("an invalid explicit runtime channel fails visibly", () => {
  assertThrows(
    () =>
      new XBrowserRuntime({
        profileRoot: "/tmp/morning-post-invalid-channel",
        browserChannel: "stable" as XBrowserChannel,
      }),
    Error,
    'X browser channel must be "chromium" or "chrome"',
  );
});

test("an omitted runtime channel takes the unmanaged installed-Chrome login path", async () => {
  const root = await mkdtemp(join(tmpdir(), "morning-post-runtime-"));
  const chromeExecutable =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const launches: Array<{ executable: string; argv: readonly string[] }> = [];
  let terminateCalls = 0;
  const chromeProcessLauncher = async (
    executable: string,
    argv: readonly string[],
  ): Promise<XChromeProcess> => {
    launches.push({ executable, argv });
    let running = true;
    const exited = Promise.withResolvers<void>();
    return {
      get running() {
        return running;
      },
      exited: exited.promise,
      async terminate() {
        terminateCalls += 1;
        running = false;
        exited.resolve();
      },
    };
  };
  try {
    const runtime = new XBrowserRuntime({
      profileRoot: root,
      chromeExecutable,
      chromeProcessLauncher,
    });
    const handle = await runtime.startHeadedLogin(PROFILE_ID);

    // The default channel is installed Chrome, so login launches the
    // app-owned profile in an unmanaged Chrome process instead of opening a
    // Playwright-headed context.
    assertEquals(launches.length, 1);
    assertStrictEquals(launches[0].executable, chromeExecutable);
    assertEquals(launches[0].argv, [
      `--user-data-dir=${await realpath(join(root, PROFILE_ID))}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://x.com/home",
    ]);
    // The unmanaged handle never touches Playwright or X: a running Chrome
    // verifies without any inspection or additional launch.
    assertStrictEquals(await handle.verify(), "awaiting_login");
    assertEquals(launches.length, 1);
    await handle.close();
    assertStrictEquals(terminateCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
