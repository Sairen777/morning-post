import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "../assertions.ts";
import { ConnectorId } from "../../src/constants.ts";
import { xCredentialSchema } from "../../src/connectors/credential-schemas.ts";
import type {
  XHeadedLoginHandle,
  XLoginState,
} from "../../src/connectors/x/index.ts";
import { XVerificationRecoveryError } from "../../src/connectors/x/runtime.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  findSourceByConnectorId,
  getDecryptedCredentials,
  upsertSourceCredentials,
} from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../../src/server/errors.ts";
import {
  type XLoginBrowserRuntime,
  type XLoginExpirationScheduler,
  XLoginSessionManager,
} from "../../src/services/x-login-service.ts";

const MASTER_KEY_BYTES = new Uint8Array(32).fill(47);
const LOGIN_TIMEOUT_MS = 30_000;

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

async function fixtureUser(
  database: Database,
  email: string,
): Promise<{ id: string }> {
  return await createUser(database, {
    name: "X Login User",
    email,
    passwordHash: null,
    systemPrompt: "Summarize tersely.",
  });
}

async function encryptedXCredentials(
  cipher: CredentialCipher,
  userId: string,
): Promise<EncryptedBlob> {
  return await cipher.encrypt(JSON.stringify({ profileId: userId }), {
    userId,
    connectorId: ConnectorId.X,
  });
}

async function connectExistingXSource(
  database: Database,
  cipher: CredentialCipher,
  userId: string,
): Promise<{ id: string }> {
  return await upsertSourceCredentials(database, {
    userId,
    connectorId: ConnectorId.X,
    credentials: await encryptedXCredentials(cipher, userId),
  });
}

class FakeXHeadedLoginHandle implements XHeadedLoginHandle {
  readonly verifySignals: Array<AbortSignal | null> = [];
  verifyCount = 0;
  closeCount = 0;
  verificationError: Error | null = null;
  #states: XLoginState[];
  #verificationGate: Promise<void> | null = null;
  #verifyWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(states: XLoginState[] = ["awaiting_login"]) {
    this.#states = [...states];
  }

  blockVerificationUntil(gate: Promise<void>): void {
    this.#verificationGate = gate;
  }

  waitForVerifyCalls(count: number): Promise<void> {
    if (this.verifyCount >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#verifyWaiters.push({ count, resolve });
    return promise;
  }

  async verify(signal?: AbortSignal): Promise<XLoginState> {
    this.verifyCount += 1;
    this.verifySignals.push(signal ?? null);
    const waiting = this.#verifyWaiters;
    this.#verifyWaiters = [];
    for (const waiter of waiting) {
      if (this.verifyCount >= waiter.count) waiter.resolve();
      else this.#verifyWaiters.push(waiter);
    }

    await this.#verificationGate;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("fake X verification aborted");
    }
    if (this.verificationError !== null) throw this.verificationError;
    return this.#states.shift() ?? "awaiting_login";
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class FakeXBrowserRuntime implements XLoginBrowserRuntime {
  readonly startedProfileIds: string[] = [];
  readonly startSignals: Array<AbortSignal | null> = [];
  readonly handles: FakeXHeadedLoginHandle[] = [];
  readonly deletedProfileIds: string[] = [];
  startError: Error | null = null;
  deleteError: Error | null = null;
  #queuedHandles: FakeXHeadedLoginHandle[] = [];

  queueHandle(handle: FakeXHeadedLoginHandle): void {
    this.#queuedHandles.push(handle);
  }

  async startHeadedLogin(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XHeadedLoginHandle> {
    this.startedProfileIds.push(profileId);
    this.startSignals.push(signal ?? null);
    if (this.startError !== null) throw this.startError;
    const handle = this.#queuedHandles.shift() ??
      new FakeXHeadedLoginHandle();
    this.handles.push(handle);
    return handle;
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.deletedProfileIds.push(profileId);
    if (this.deleteError !== null) throw this.deleteError;
  }
}

class FakeExpirationScheduler {
  readonly delays: number[] = [];
  cancelCount = 0;

  readonly schedule: XLoginExpirationScheduler = (_callback, delayMs) => {
    this.delays.push(delayMs);
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      this.cancelCount += 1;
    };
  };
}

function loginManager(
  database: Database,
  runtime: FakeXBrowserRuntime,
  cipher: CredentialCipher,
  options: {
    now?: () => number;
    scheduler?: FakeExpirationScheduler;
  } = {},
): { manager: XLoginSessionManager; scheduler: FakeExpirationScheduler } {
  const scheduler = options.scheduler ?? new FakeExpirationScheduler();
  return {
    manager: new XLoginSessionManager({
      database,
      credentialCipher: cipher,
      browserRuntime: runtime,
      loginTimeoutMs: LOGIN_TIMEOUT_MS,
      now: options.now ?? (() => 1_000),
      scheduleExpiration: scheduler.schedule,
    }),
    scheduler,
  };
}

test("X login starts a headed profile in the awaiting-login state", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-start@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager, scheduler } = loginManager(
      database,
      runtime,
      credentialCipher(),
    );

    const status = await manager.startLogin(user.id);

    assertEquals(status, {
      sessionId: status.sessionId,
      status: "awaiting_login",
      expiresAtMs: 31_000,
    });
    assertEquals(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        status.sessionId,
      ),
      true,
    );
    assertEquals(runtime.startedProfileIds, [user.id]);
    assertEquals(runtime.startedProfileIds[0], user.id.toLowerCase());
    assertEquals(runtime.startSignals[0]?.aborted, false);
    assertEquals(scheduler.delays, [LOGIN_TIMEOUT_MS]);
    assertEquals(handle.closeCount, 0);

    await manager.cancel(status.sessionId, user.id);
  });
});

test("X login sessions are invisible and immutable to another user", async () => {
  await withTestDb(async (database) => {
    const owner = await fixtureUser(database, "x-owner@example.com");
    const stranger = await fixtureUser(database, "x-stranger@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, credentialCipher());
    const started = await manager.startLogin(owner.id);

    await assertRejects(
      () => manager.getStatus(started.sessionId, stranger.id),
      NotFoundError,
      "X login session not found",
    );
    await assertRejects(
      () => manager.verify(started.sessionId, stranger.id),
      NotFoundError,
      "X login session not found",
    );
    await assertRejects(
      () => manager.cancel(started.sessionId, stranger.id),
      NotFoundError,
      "X login session not found",
    );

    assertEquals(handle.verifyCount, 0);
    assertEquals(handle.closeCount, 0);
    assertEquals(runtime.deletedProfileIds, []);
    assertEquals(await manager.getStatus(started.sessionId, owner.id), started);

    await manager.cancel(started.sessionId, owner.id);
  });
});

test("X verification reports Chat unlock without committing credentials", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-chat-unlock@example.com");
    const cipher = credentialCipher();
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["awaiting_chat_unlock"]);
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, cipher);
    const started = await manager.startLogin(user.id);

    const status = await manager.verify(started.sessionId, user.id);

    assertEquals(status, {
      sessionId: started.sessionId,
      status: "awaiting_chat_unlock",
      expiresAtMs: started.expiresAtMs,
    });
    assertEquals(await manager.getStatus(started.sessionId, user.id), status);
    assertEquals(await findSourceByConnectorId(database, user.id, ConnectorId.X), null);
    assertEquals(handle.closeCount, 0);
    assertEquals(runtime.deletedProfileIds, []);

    await manager.cancel(started.sessionId, user.id);
  });
});

test("successful X verification commits only the canonical managed-profile credential", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-complete@example.com");
    const cipher = credentialCipher();
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["complete"]);
    runtime.queueHandle(handle);
    const { manager, scheduler } = loginManager(database, runtime, cipher);
    const started = await manager.startLogin(user.id);

    const status = await manager.verify(started.sessionId, user.id);

    assertEquals(status, {
      sessionId: started.sessionId,
      status: "complete",
      expiresAtMs: started.expiresAtMs,
    });
    assertEquals(handle.verifyCount, 1);
    assertEquals(handle.closeCount, 1);
    assertEquals(scheduler.cancelCount, 1);
    assertEquals(runtime.deletedProfileIds, []);

    const source = await findSourceByConnectorId(
      database,
      user.id,
      ConnectorId.X,
    );
    assertExists(source);
    assertEquals(source.connected, true);
    const decrypted = await getDecryptedCredentials(
      database,
      source.id,
      user.id,
      cipher,
    );
    assertEquals(xCredentialSchema.parse(decrypted), { profileId: user.id });
    assertEquals(user.id, user.id.toLowerCase());
    assertEquals(await manager.getStatus(started.sessionId, user.id), status);

    await manager.dispose();
    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, []);
  });
});

test("cancelling a fresh X login closes its handle, removes its profile, and forgets the session", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-cancel@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager, scheduler } = loginManager(
      database,
      runtime,
      credentialCipher(),
    );
    const started = await manager.startLogin(user.id);

    await manager.cancel(started.sessionId, user.id);

    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.startSignals[0]?.aborted, true);
    assertEquals(runtime.deletedProfileIds, [user.id]);
    assertEquals(scheduler.cancelCount, 1);
    await assertRejects(
      () => manager.getStatus(started.sessionId, user.id),
      NotFoundError,
      "X login session not found",
    );
  });
});

test("an expired fresh X login becomes terminal and removes its profile", async () => {
  await withTestDb(async (database) => {
    let now = 4_000;
    const user = await fixtureUser(database, "x-expired@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["complete"]);
    runtime.queueHandle(handle);
    const { manager, scheduler } = loginManager(
      database,
      runtime,
      credentialCipher(),
      { now: () => now },
    );
    const started = await manager.startLogin(user.id);
    now = started.expiresAtMs;

    const status = await manager.getStatus(started.sessionId, user.id);

    assertEquals(status, {
      sessionId: started.sessionId,
      status: "expired",
      expiresAtMs: started.expiresAtMs,
    });
    assertEquals(handle.closeCount, 1);
    assertEquals(handle.verifyCount, 0);
    assertEquals(runtime.startSignals[0]?.aborted, true);
    assertEquals(runtime.deletedProfileIds, [user.id]);
    assertEquals(scheduler.cancelCount, 1);
    assertEquals(
      await manager.verify(started.sessionId, user.id),
      status,
    );
    assertEquals(await findSourceByConnectorId(database, user.id, ConnectorId.X), null);
  });
});

test("fresh X verification and reopen failures preserve the profile for retry", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-verify-error@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["complete"]);
    handle.verificationError = new Error(
      "secret cookie from /Users/example/browser-profile",
    );
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, credentialCipher());
    const started = await manager.startLogin(user.id);

    const status = await manager.verify(started.sessionId, user.id);

    assertEquals(status, {
      sessionId: started.sessionId,
      status: "awaiting_login",
      expiresAtMs: started.expiresAtMs,
      error:
        "X login verification failed; your dedicated browser profile was preserved, but no recovery window opened. Retry Verify to reopen it. Cancel only if you want to abandon this login and delete the uncommitted profile.",
    });
    assertEquals(status.error?.includes("secret cookie"), false);
    assertEquals(handle.closeCount, 0);
    assertEquals(runtime.deletedProfileIds, []);
    assertEquals(await findSourceByConnectorId(database, user.id, ConnectorId.X), null);

    handle.verificationError = new XVerificationRecoveryError("home", {
      cause: new Error("secret recovery details"),
    });
    const reopened = await manager.verify(started.sessionId, user.id);
    assertEquals(reopened, {
      sessionId: started.sessionId,
      status: "awaiting_login",
      expiresAtMs: started.expiresAtMs,
      error:
        "X authentication evidence could not be inspected; your dedicated Chrome profile was preserved and Chrome was reopened at X Home. Confirm the authenticated timeline is visible, fully quit Chrome (Cmd-Q on macOS), then Verify again or cancel this login.",
    });
    assertEquals(reopened.error?.includes("secret recovery details"), false);
    assertEquals(runtime.deletedProfileIds, []);

    handle.verificationError = new XVerificationRecoveryError("messages", {
      cause: new Error("chat setup timeout"),
    });
    const messagesRecovery = await manager.verify(started.sessionId, user.id);
    assertEquals(messagesRecovery, {
      sessionId: started.sessionId,
      status: "awaiting_login",
      expiresAtMs: started.expiresAtMs,
      error:
        "X Chat readiness could not be inspected; your dedicated Chrome profile was preserved and Chrome was reopened at X Messages. Complete any visible Chat setup or unlock, fully quit Chrome (Cmd-Q on macOS), then Verify again or cancel this login.",
    });
    assertEquals(messagesRecovery.error?.includes("chat setup timeout"), false);
    assertEquals(runtime.deletedProfileIds, []);

    handle.verificationError = null;
    const retried = await manager.verify(started.sessionId, user.id);

    assertEquals(retried.status, "complete");
    assertEquals(handle.verifyCount, 4);
    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, []);
    assertExists(await findSourceByConnectorId(database, user.id, ConnectorId.X));
  });
});

test("credential commit failure remains terminal and cleans a fresh profile", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-commit-error@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["complete"]);
    runtime.queueHandle(handle);
    const cipher = credentialCipher();
    Object.defineProperty(cipher, "encrypt", {
      configurable: true,
      value: async () => {
        throw new Error("secret credential commit failure");
      },
    });
    const { manager } = loginManager(database, runtime, cipher);
    const started = await manager.startLogin(user.id);

    const status = await manager.verify(started.sessionId, user.id);

    assertEquals(status, {
      sessionId: started.sessionId,
      status: "error",
      expiresAtMs: started.expiresAtMs,
      error: "X login verification failed",
    });
    assertEquals(status.error?.includes("secret credential"), false);
    assertEquals(handle.closeCount, 1);
    assertEquals(handle.verifyCount, 1);
    assertEquals(runtime.deletedProfileIds, [user.id]);
    assertEquals(await findSourceByConnectorId(database, user.id, ConnectorId.X), null);
    assertEquals(await manager.verify(started.sessionId, user.id), status);
  });
});

test("a fresh headed-launch failure is sanitized and cleans up its profile", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-start-error@example.com");
    const runtime = new FakeXBrowserRuntime();
    runtime.startError = new Error("Chromium failed with --password=secret");
    const { manager } = loginManager(database, runtime, credentialCipher());

    const status = await manager.startLogin(user.id);

    assertEquals(status, {
      sessionId: status.sessionId,
      status: "error",
      expiresAtMs: 31_000,
      error: "X browser login failed",
    });
    assertEquals(status.error?.includes("secret"), false);
    assertEquals(runtime.handles, []);
    assertEquals(runtime.deletedProfileIds, [user.id]);
    assertEquals(await manager.getStatus(status.sessionId, user.id), status);
  });
});

test("an active X login rejects another concurrent session for the same user", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-concurrent-start@example.com");
    const runtime = new FakeXBrowserRuntime();
    const { manager } = loginManager(database, runtime, credentialCipher());

    const results = await Promise.allSettled([
      manager.startLogin(user.id),
      manager.startLogin(user.id),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
    const rejection = rejected[0];
    assert(rejection?.status === "rejected");
    assert(rejection.reason instanceof ConflictError);
    assertEquals(rejection.reason.message, "an X login session is already active");
    assertEquals(runtime.handles.length, 1);
    assertEquals(runtime.startedProfileIds, [user.id]);

    const successful = fulfilled[0];
    assert(successful?.status === "fulfilled");
    await manager.cancel(successful.value.sessionId, user.id);
  });
});

test("X login rejects a second verification while the first is in progress", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-concurrent-verify@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["awaiting_chat_unlock"]);
    const gate = Promise.withResolvers<void>();
    handle.blockVerificationUntil(gate.promise);
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, credentialCipher());
    const started = await manager.startLogin(user.id);

    const firstVerification = manager.verify(started.sessionId, user.id);
    await handle.waitForVerifyCalls(1);
    await assertRejects(
      () => manager.verify(started.sessionId, user.id),
      ConflictError,
      "X login verification is already in progress",
    );
    gate.resolve();

    assertEquals(await firstVerification, {
      sessionId: started.sessionId,
      status: "awaiting_chat_unlock",
      expiresAtMs: started.expiresAtMs,
    });
    assertEquals(handle.verifyCount, 1);
    await manager.cancel(started.sessionId, user.id);
  });
});

test("an aborted verification request leaves the headed login available for retry", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-aborted-verify@example.com");
    const runtime = new FakeXBrowserRuntime();
    const handle = new FakeXHeadedLoginHandle(["awaiting_chat_unlock"]);
    const gate = Promise.withResolvers<void>();
    handle.blockVerificationUntil(gate.promise);
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, credentialCipher());
    const started = await manager.startLogin(user.id);
    const controller = new AbortController();

    const verification = manager.verify(
      started.sessionId,
      user.id,
      controller.signal,
    );
    await handle.waitForVerifyCalls(1);
    controller.abort(new Error("request cancelled"));
    gate.resolve();

    await assertRejects(() => verification, Error, "request cancelled");
    assertEquals(await manager.getStatus(started.sessionId, user.id), started);
    assertEquals(handle.closeCount, 0);
    assertEquals(runtime.startSignals[0]?.aborted, false);

    assertEquals(await manager.verify(started.sessionId, user.id), {
      sessionId: started.sessionId,
      status: "awaiting_chat_unlock",
      expiresAtMs: started.expiresAtMs,
    });
    assertEquals(handle.verifyCount, 2);
    assertEquals(handle.closeCount, 0);
    await manager.cancel(started.sessionId, user.id);
  });
});

test("disposing X login sessions aborts, closes, and cleans every fresh profile", async () => {
  await withTestDb(async (database) => {
    const firstUser = await fixtureUser(database, "x-dispose-a@example.com");
    const secondUser = await fixtureUser(database, "x-dispose-b@example.com");
    const runtime = new FakeXBrowserRuntime();
    const firstHandle = new FakeXHeadedLoginHandle();
    const secondHandle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(firstHandle);
    runtime.queueHandle(secondHandle);
    const { manager, scheduler } = loginManager(
      database,
      runtime,
      credentialCipher(),
    );
    const first = await manager.startLogin(firstUser.id);
    await manager.startLogin(secondUser.id);

    await manager.dispose();

    assertEquals(firstHandle.closeCount, 1);
    assertEquals(secondHandle.closeCount, 1);
    assertEquals(runtime.startSignals.map((signal) => signal?.aborted), [true, true]);
    assertEquals(runtime.deletedProfileIds, [firstUser.id, secondUser.id]);
    assertEquals(scheduler.cancelCount, 2);
    await assertRejects(
      () => manager.getStatus(first.sessionId, firstUser.id),
      ConflictError,
      "X login service is unavailable",
    );
    await assertRejects(
      () => manager.startLogin(firstUser.id),
      ConflictError,
      "X login service is unavailable",
    );

    await manager.dispose();
    assertEquals(firstHandle.closeCount, 1);
    assertEquals(secondHandle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, [firstUser.id, secondUser.id]);
  });
});

test("cancellation preserves the profile and credentials of an already-connected X source", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-preserve-cancel@example.com");
    const cipher = credentialCipher();
    const existing = await connectExistingXSource(database, cipher, user.id);
    const runtime = new FakeXBrowserRuntime();
    runtime.deleteError = new Error("connected profiles must not be deleted");
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, cipher);
    const started = await manager.startLogin(user.id);

    await manager.cancel(started.sessionId, user.id);

    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, []);
    const preserved = await findSourceByConnectorId(
      database,
      user.id,
      ConnectorId.X,
    );
    assertExists(preserved);
    assertEquals(preserved.id, existing.id);
    assertEquals(preserved.connected, true);
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, preserved.id, user.id, cipher),
      ),
      { profileId: user.id },
    );
  });
});

test("expiry preserves the profile and credentials of an already-connected X source", async () => {
  await withTestDb(async (database) => {
    let now = 8_000;
    const user = await fixtureUser(database, "x-preserve-expiry@example.com");
    const cipher = credentialCipher();
    const existing = await connectExistingXSource(database, cipher, user.id);
    const runtime = new FakeXBrowserRuntime();
    runtime.deleteError = new Error("connected profiles must not be deleted");
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, cipher, {
      now: () => now,
    });
    const started = await manager.startLogin(user.id);
    now = started.expiresAtMs;

    const status = await manager.getStatus(started.sessionId, user.id);

    assertEquals(status.status, "expired");
    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, []);
    const preserved = await findSourceByConnectorId(
      database,
      user.id,
      ConnectorId.X,
    );
    assertExists(preserved);
    assertEquals(preserved.id, existing.id);
    assertEquals(preserved.connected, true);
  });
});

test("verification failure leaves an already-connected X profile retryable", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-preserve-error@example.com");
    const cipher = credentialCipher();
    const existing = await connectExistingXSource(database, cipher, user.id);
    const runtime = new FakeXBrowserRuntime();
    runtime.deleteError = new Error("connected profiles must not be deleted");
    const handle = new FakeXHeadedLoginHandle();
    handle.verificationError = new Error("provider page crashed");
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, cipher);
    const started = await manager.startLogin(user.id);

    const status = await manager.verify(started.sessionId, user.id);

    assertEquals(status.status, "awaiting_login");
    assertEquals(
      status.error,
      "X login verification failed; your dedicated browser profile was preserved, but no recovery window opened. Retry Verify to reopen it. Cancel only if you want to abandon this login and delete the uncommitted profile.",
    );
    assertEquals(handle.closeCount, 0);
    assertEquals(runtime.deletedProfileIds, []);
    const preserved = await findSourceByConnectorId(
      database,
      user.id,
      ConnectorId.X,
    );
    assertExists(preserved);
    assertEquals(preserved.id, existing.id);
    assertEquals(preserved.connected, true);
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, preserved.id, user.id, cipher),
      ),
      { profileId: user.id },
    );
  });
});

test("profile cleanup rejection leaves a safe terminal X login status observable", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "x-cleanup-error@example.com");
    const runtime = new FakeXBrowserRuntime();
    runtime.deleteError = new Error(
      "EACCES deleting /Users/example/profile/Cookies with secret-token",
    );
    const handle = new FakeXHeadedLoginHandle();
    runtime.queueHandle(handle);
    const { manager } = loginManager(database, runtime, credentialCipher());
    const started = await manager.startLogin(user.id);

    const error = await assertRejects(
      () => manager.cancel(started.sessionId, user.id),
      ConflictError,
      "X browser profile cleanup failed",
    );

    assertEquals(error.message, "X browser profile cleanup failed");
    assertEquals(error.message.includes("secret-token"), false);
    assertEquals(handle.closeCount, 1);
    assertEquals(runtime.deletedProfileIds, [user.id]);
    assertEquals(await manager.getStatus(started.sessionId, user.id), {
      sessionId: started.sessionId,
      status: "error",
      expiresAtMs: started.expiresAtMs,
      error: "X browser profile cleanup failed",
    });
    assertEquals(await findSourceByConnectorId(database, user.id, ConnectorId.X), null);
  });
});
