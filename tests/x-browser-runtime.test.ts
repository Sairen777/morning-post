import { test } from "bun:test";
import type { BrowserContext, Page } from "playwright";

import type {
  XBrowserSessions,
  XOwnedBrowserSession,
  XUnmanagedBrowserSession,
} from "../src/connectors/x/browser-session.ts";
import {
  UnmanagedLoginHandle,
  XVerificationRecoveryError,
} from "../src/connectors/x/runtime.ts";
import type { XLoginState } from "../src/connectors/x/x.types.ts";
import { assertEquals, assertRejects, assertStrictEquals } from "./assertions.ts";

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
