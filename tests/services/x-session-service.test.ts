import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "../assertions.ts";
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import {
  EnvMasterKeyProvider,
  type CredentialOwner,
} from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import { sources } from "../../src/db/schema/source.ts";
import { TwexApiError } from "../../src/connectors/x/twex-api-client.ts";
import { xCredentialSchema } from "../../src/connectors/credential-schemas.ts";
import {
  xSessionInputSchema,
  XSessionService,
  type XSessionInput,
  type XSessionValidator,
  type XSessionValidatorFactory,
} from "../../src/services/x-session-service.ts";
import { ConflictError, ValidationError } from "../../src/server/errors.ts";
import { validate } from "../../src/server/validate.ts";
import {
  createSource,
  deleteSourceCredentials,
  findSourceByConnectorId,
  findSourceCredentialStateByConnectorId,
  getDecryptedCredentials,
} from "../../src/repositories/source-repository.ts";
import {
  createOrReviveFeed,
  listFeedsForSource,
  setLastFetched,
} from "../../src/repositories/feed-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  listItemsForFeedInWindow,
  upsertItems,
} from "../../src/repositories/item-repository.ts";
import { DatabaseXContentCache } from "../../src/repositories/x-content-cache-repository.ts";
import { replaceDiscoveredFeedsForRevision } from "../../src/repositories/x-discovered-feed-repository.ts";

const API_KEY = "twex-api-key-123";
const AUTH_TOKEN = "x-auth-token-abc";
const COOKIE = "auth_token=x-auth-token-abc; ct0=csrf-token-xyz";
const LIST_FEED = "x:list:42";

function xInput(overrides: Partial<XSessionInput> = {}): XSessionInput {
  return {
    apiKey: API_KEY,
    authToken: AUTH_TOKEN,
    cookie: COOKIE,
    ...overrides,
  };
}

function cipher(key: number): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(key)));
}

class FakeValidatorFactory implements XSessionValidatorFactory {
  readonly created: XSessionInput[] = [];

  constructor(
    private readonly result: (
      signal?: AbortSignal,
    ) => Promise<{ userId: string; username: string }>,
  ) {}

  create(input: XSessionInput): XSessionValidator {
    this.created.push(input);
    return { validate: (signal) => this.result(signal) };
  }
}

/** Credential cipher whose encrypt can be paused until the test releases it. */
class PausableCipher extends CredentialCipher {
  readonly encryptStarted = Promise.withResolvers<void>();
  #releaseEncrypt: (() => void) | undefined;

  constructor() {
    super(new EnvMasterKeyProvider(new Uint8Array(32).fill(23)));
  }

  override async encrypt(
    plaintext: string,
    owner: CredentialOwner,
  ): Promise<EncryptedBlob> {
    this.encryptStarted.resolve();
    await new Promise<void>((resolve) => {
      this.#releaseEncrypt = resolve;
    });
    return await super.encrypt(plaintext, owner);
  }

  releaseEncrypt(): void {
    this.#releaseEncrypt?.();
  }
}

function userInput(email: string) {
  return {
    name: "X Reader",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function cachedPost(externalId = "t-1", date = 1_500) {
  return {
    kind: "post" as const,
    externalId,
    platformId: externalId,
    date,
    text: "cached post",
    author: "Author",
    url: `https://x.com/author/status/${externalId}`,
    replyCount: null,
    repostCount: null,
    likeCount: null,
    viewCount: null,
  };
}

async function seedCache(
  database: Database,
  sourceId: string,
): Promise<DatabaseXContentCache> {
  const cache = new DatabaseXContentCache(database, sourceId);
  cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, [cachedPost()]);
  return cache;
}

/**
 * Authorizes `LIST_FEED` under the source's initial credential revision, as
 * a real discovery would, so direct feed creation below mirrors a cataloged
 * subscription.
 */
function seedCatalog(database: Database, sourceId: string): void {
  replaceDiscoveredFeedsForRevision(database, sourceId, 1, [
    { externalId: LIST_FEED, name: "X List", kind: "news" },
  ]);
}

function normalizedXItem(
  feedExternalId: string,
  externalId: string,
): Parameters<typeof upsertItems>[2][number] {
  return {
    connectorId: ConnectorId.X,
    feedExternalId,
    externalId,
    date: 1_500,
    title: null,
    text: "account-bound item",
    author: "alice",
    url: `https://x.com/alice/status/${externalId}`,
  };
}

test("xSessionInputSchema requires matching auth_token and nonempty ct0 without leaking secrets", () => {
  const parsed = xSessionInputSchema.safeParse(xInput());
  assert(parsed.success, "valid input must parse");

  for (const bad of [
    { cookie: "auth_token=x-auth-token-abc" },
    { cookie: "ct0=csrf-token-xyz" },
    { cookie: "auth_token=other-token; ct0=csrf-token-xyz" },
    { cookie: "auth_token=x-auth-token-abc; auth_token=x-auth-token-abc; ct0=csrf-token-xyz" },
    { cookie: "auth_token=x-auth-token-abc; ct0=csrf-token-xyz; auth_token=x-auth-token-abc" },
    { cookie: "auth_token=x-auth-token-abc; ct0=csrf-token-xyz; ct0=csrf-token-xyz" },
    { cookie: "ct0=csrf-token-xyz; ct0=csrf-token-xyz; auth_token=x-auth-token-abc" },
    { cookie: "auth_token=x-auth-token-abc; ct0=csrf-token-\u0000xyz" },
    { cookie: "auth_token=x-auth-token-abc;\nct0=csrf-token-xyz" },
    { apiKey: "" },
    { authToken: "" },
    { cookie: "" },
    { unexpectedKey: "nope" },
  ]) {
    const result = xSessionInputSchema.safeParse(xInput(bad));
    assert(!result.success, `expected rejection for ${JSON.stringify(bad)}`);
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    for (const secret of [API_KEY, AUTH_TOKEN, "other-token"]) {
      assertEquals(message.includes(secret), false, `message leaked ${secret}`);
    }
  }
});

test("XSessionService validates before persisting and stores encrypted defaults", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session@example.com"));
    const validatorFactory = new FakeValidatorFactory(() =>
      Promise.resolve({ userId: "x-user-1", username: "alice" })
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory,
    });

    const source = await service.connect(user.id, xInput());

    assertEquals(validatorFactory.created, [xInput()]);
    assertEquals(source.connectorId, ConnectorId.X);
    assertEquals(source.connected, true);
    assertEquals(
      findSourceCredentialStateByConnectorId(
        database,
        user.id,
        ConnectorId.X,
      )?.credentialRevision,
      1,
    );
    const stored = await getDecryptedCredentials(
      database,
      source.id,
      user.id,
      cipher(23),
    );
    assertEquals(stored, {
      apiKey: API_KEY,
      authToken: AUTH_TOKEN,
      cookie: COOKIE,
      listQuery: "alice",
      xUserId: "x-user-1",
      xUsername: "alice",
    });
  });
});

test("XSessionService persists optional pin and trimmed list query, blank query derives username", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-pin@example.com"));
    const validatorFactory = new FakeValidatorFactory(() =>
      Promise.resolve({ userId: "x-user-1", username: "alice" })
    );
    const service = new XSessionService(
      { database, credentialCipher: cipher(23), validatorFactory },
    );

    const source = await service.connect(user.id, xInput({
      pin: "9876",
      listQuery: "  morning lists  ",
    }));
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, source.id, user.id, cipher(23)),
      ).listQuery,
      "morning lists",
    );

    await service.connect(user.id, xInput({ listQuery: "   " }));
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, source.id, user.id, cipher(23)),
      ).listQuery,
      "alice",
    );
  });
});

test("XSessionService rejects credential failures without persisting or leaking secrets", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-invalid@example.com"),
    );
    for (const failure of [
      new TwexApiError("upstream said 401", 401),
      new TwexApiError("upstream said 403", undefined, 403),
      new Error(`leaked ${COOKIE} in transit`),
    ]) {
      const service = new XSessionService({
        database,
        credentialCipher: cipher(23),
        validatorFactory: new FakeValidatorFactory(() => Promise.reject(failure)),
      });
      const error = await assertRejects(
        () => service.connect(user.id, xInput()),
        ValidationError,
        "X credentials are invalid or expired",
      );
      for (const secret of [API_KEY, AUTH_TOKEN, COOKIE]) {
        assertEquals(error.message.includes(secret), false, `leaked ${secret}`);
      }
      assertEquals(
        await findSourceByConnectorId(database, user.id, ConnectorId.X),
        null,
        "failed validation must not persist a source",
      );
    }
  });
});

test("XSessionService keeps upstream availability failures distinct from credential failures", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-upstream@example.com"),
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.reject(new TwexApiError("Twex API unavailable", 503))
      ),
    });
    await assertRejects(
      () => service.connect(user.id, xInput()),
      TwexApiError,
      "Twex API unavailable",
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.X),
      null,
    );
  });
});

test("XSessionService aborted during validation persists nothing", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-abort@example.com"));
    const controller = new AbortController();
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() => {
        controller.abort();
        return Promise.resolve({ userId: "x-user-1", username: "alice" });
      }),
    });
    await assertRejects(
      () => service.connect(user.id, xInput(), controller.signal),
      DOMException,
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.X),
      null,
    );
  });
});

test("XSessionService pre-aborted input aborts before validation and stores nothing", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-preabort@example.com"));
    const validatorFactory = new FakeValidatorFactory(() =>
      Promise.resolve({ userId: "x-user-1", username: "alice" })
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory,
    });

    const controller = new AbortController();
    const reason = new DOMException("already aborted", "AbortError");
    controller.abort(reason);

    const error = await assertRejects(
      () => service.connect(user.id, xInput(), controller.signal),
      DOMException,
      "already aborted",
    );
    // The exact signal reason propagates untouched, before any remote call.
    assertStrictEquals(error, reason);
    assertEquals(validatorFactory.created, []);
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.X),
      null,
    );
  });
});

test("XSessionService abort during credential encryption preserves the exact abort reason and stores nothing", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-encrypt-abort@example.com"),
    );
    const pausableCipher = new PausableCipher();
    const service = new XSessionService({
      database,
      credentialCipher: pausableCipher,
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });

    const controller = new AbortController();
    const reason = new DOMException("encryption aborted", "AbortError");
    const connectPromise = service.connect(
      user.id,
      xInput(),
      controller.signal,
    );

    // Abort while the encrypted credential is being produced, after remote
    // validation has succeeded.
    await pausableCipher.encryptStarted.promise;
    controller.abort(reason);
    pausableCipher.releaseEncrypt();

    const error = await assertRejects(
      () => connectPromise,
      DOMException,
      "encryption aborted",
    );
    assertStrictEquals(error, reason);
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.X),
      null,
    );
  });
});

test("XSessionService reconnect with the same derived user preserves cache and feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-same@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    setLastFetched(database, feed.id, user.id, 77_000);

    const second = await service.connect(user.id, xInput({
      apiKey: "replacement-key",
      authToken: "replacement-token",
      cookie: "auth_token=replacement-token; ct0=replacement-ct0",
    }));

    assertEquals(second.id, first.id);
    // Credentials were replaced…
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).apiKey,
      "replacement-key",
    );
    // …but the cache and the active feed survived the reconnect. The
    // reconnect still bumped the revision so pre-reconnect handles are fenced.
    assertEquals(
      findSourceCredentialStateByConnectorId(
        database,
        user.id,
        ConnectorId.X,
      )?.credentialRevision,
      2,
    );
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);
    const feeds = listFeedsForSource(database, first.id, user.id);
    assertEquals(feeds.map((entry) => entry.id), [feed.id]);
    // The ingestion watermark survives a same-identity reconnect.
    assertEquals(feeds[0].lastFetchedPeriodEndMs, 77_000);
  });
});

test("XSessionService changed identity resets cache and soft-deletes active feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-changed@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    setLastFetched(database, feed.id, user.id, 77_000);

    // A different derived user reconnects with fresh credentials.
    const secondService = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-2", username: "bob" })
      ),
    });
    const second = await secondService.connect(user.id, xInput({
      apiKey: "bob-key",
      authToken: "bob-token",
      cookie: "auth_token=bob-token; ct0=bob-ct0",
    }));

    assertEquals(second.id, first.id);
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000), []);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    // The active feed was soft-deleted: absent from the live listing, marked
    // disabled with a deletedAt timestamp and no ingestion watermark in the
    // persisted row (so a revived feed under the new account cannot skip
    // ingestion from the prior account's watermark).
    assertEquals(listFeedsForSource(database, first.id, user.id), []);
    const deleted = listFeedsForSource(database, first.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assertEquals(deleted[0].enabled, false);
    assert(deleted[0].deletedAt !== null);
    assertEquals(deleted[0].lastFetchedPeriodEndMs, null);
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).xUserId,
      "x-user-2",
    );
  });
});

test("XSessionService same-identity reconnect preserves normalized items", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-same-items@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    await upsertItems(database, feed.id, [
      normalizedXItem(LIST_FEED, "t-1"),
    ]);

    await service.connect(user.id, xInput({
      apiKey: "replacement-key",
      authToken: "replacement-token",
      cookie: "auth_token=replacement-token; ct0=replacement-ct0",
    }));

    // Same-account reconnect is preservation-only: committed normalized items
    // survive, so a revival never re-exposes (or loses) same-account content.
    const preserved = await listItemsForFeedInWindow(
      database,
      feed.id,
      1_000,
      2_000,
    );
    assertEquals(preserved.length, 1);
    assertEquals(preserved[0].feedId, feed.id);
    assertEquals(preserved[0].externalId, "t-1");
    assertEquals(preserved[0].payload, normalizedXItem(LIST_FEED, "t-1"));
    assertEquals(listFeedsForSource(database, first.id, user.id).length, 1);
  });
});

test("XSessionService changed identity deletes normalized items for every feed", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-changed-items@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    await upsertItems(database, feed.id, [
      normalizedXItem(LIST_FEED, "t-1"),
    ]);
    setLastFetched(database, feed.id, user.id, 77_000);

    // A different derived user reconnects with fresh credentials.
    const secondService = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-2", username: "bob" })
      ),
    });
    await secondService.connect(user.id, xInput({
      apiKey: "bob-key",
      authToken: "bob-token",
      cookie: "auth_token=bob-token; ct0=bob-ct0",
    }));

    // Old-account normalized items are gone so a revived feed id cannot
    // expose the previous account's content.
    assertEquals(
      await listItemsForFeedInWindow(database, feed.id, 1_000, 2_000),
      [],
    );
    const deleted = listFeedsForSource(database, first.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assertEquals(deleted[0].enabled, false);
    assertEquals(deleted[0].lastFetchedPeriodEndMs, null);

    // Reviving the feed under the new account cannot see the old items. A
    // fresh discovery at the new revision authorizes the target again.
    replaceDiscoveredFeedsForRevision(database, first.id, 2, [
      { externalId: LIST_FEED, name: "X List", kind: "news" },
    ]);
    const revived = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    assertEquals(revived.id, feed.id);
    assertEquals(
      await listItemsForFeedInWindow(database, revived.id, 1_000, 2_000),
      [],
    );
  });
});

test("XSessionService legacy prior identity resets cache and feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-legacy@example.com"));
    // ProfileId-era credentials cannot be parsed by xCredentialSchema.
    const legacyBlob = await cipher(23).encrypt(
      JSON.stringify({ profileId: "legacy-profile-1" }),
      { userId: user.id, connectorId: ConnectorId.X },
    );
    const legacySource = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: legacyBlob,
    });
    const cache = await seedCache(database, legacySource.id);
    seedCatalog(database, legacySource.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: legacySource.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    setLastFetched(database, feed.id, user.id, 77_000);

    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const source = await service.connect(user.id, xInput());

    assertEquals(source.id, legacySource.id);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(listFeedsForSource(database, legacySource.id, user.id), []);
    const deleted = listFeedsForSource(database, legacySource.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assert(deleted[0].deletedAt !== null);
    assertEquals(deleted[0].lastFetchedPeriodEndMs, null);
  });
});

test("XSessionService disconnected prior source resets cache and restores credentials", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-disconnected@example.com"),
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);

    await deleteSourceCredentials(database, first.id, user.id);
    assertEquals(
      (await findSourceByConnectorId(database, user.id, ConnectorId.X))
        ?.connected,
      false,
    );

    const reconnected = await service.connect(user.id, xInput({
      apiKey: "fresh-key",
      authToken: "fresh-token",
      cookie: "auth_token=fresh-token; ct0=fresh-ct0",
    }));

    assertEquals(reconnected.id, first.id);
    assertEquals(reconnected.connected, true);
    // Stale cache from the revoked identity did not survive the reconnect.
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).apiKey,
      "fresh-key",
    );
  });
});

test("XSessionService undecryptable prior credentials reset cache and feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-undecryptable@example.com"),
    );
    // Stored under a master key the reconnect cipher cannot unwrap.
    const foreignBlob = await cipher(99).encrypt(
      JSON.stringify({
        apiKey: API_KEY,
        authToken: AUTH_TOKEN,
        cookie: COOKIE,
        listQuery: "lists",
        xUserId: "x-user-1",
        xUsername: "alice",
      }),
      { userId: user.id, connectorId: ConnectorId.X },
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: foreignBlob,
    });
    const cache = await seedCache(database, source.id);
    seedCatalog(database, source.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });
    setLastFetched(database, feed.id, user.id, 77_000);

    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    await service.connect(user.id, xInput());

    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(listFeedsForSource(database, source.id, user.id), []);
    const deleted = listFeedsForSource(database, source.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assert(deleted[0].deletedAt !== null);
    assertEquals(deleted[0].lastFetchedPeriodEndMs, null);
  });
});

test("XSessionService refused commit leaves cache, feeds, and credentials untouched", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-refused@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });

    // A commit operation that refuses to run (e.g. the route deadline fired)
    // must abort the whole reconnect: no reset, no credential change.
    const refusedCommit = async <Result>(): Promise<Result> => {
      throw new Error("commit refused");
    };
    await assertRejects(
      () =>
        service.connect(user.id, xInput({ apiKey: "new-key" }), undefined, refusedCommit),
      Error,
      "commit refused",
    );

    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(
      listFeedsForSource(database, first.id, user.id).map((entry) => entry.id),
      [feed.id],
    );
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).apiKey,
      API_KEY,
    );
  });
});

test("XSessionService schema rejects over-length secrets and unknown keys", () => {
  assertThrows(
    () => validate(xSessionInputSchema, xInput({ apiKey: "k".repeat(2_049) })),
    ValidationError,
    "apiKey is too long",
  );
  assertThrows(
    () =>
      validate(
        xSessionInputSchema,
        xInput({ cookie: `auth_token=${AUTH_TOKEN}; ct0=${"c".repeat(17 * 1024)}` }),
      ),
    ValidationError,
    "cookie is too long",
  );
  const unknownKeyError = assertThrows(
    () => validate(xSessionInputSchema, { ...xInput(), profileId: "legacy" }),
    ValidationError,
    "Unrecognized key",
  );
  assertEquals(
    unknownKeyError.message.includes(API_KEY),
    false,
    "validation errors must not echo secrets",
  );
});

test("XSessionService reconnect CAS rejects a disconnect that lands between snapshot and commit", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-cas-disconnect@example.com"),
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });

    // The competing disconnect commits after this request's prevalidation
    // snapshot but before its own commit: the CAS must reject the stale write.
    const racingCommit = async <Result>(operation: () => Result): Promise<Result> => {
      await deleteSourceCredentials(database, first.id, user.id);
      return await operation();
    };
    await assertRejects(
      () =>
        service.connect(
          user.id,
          xInput({
            apiKey: "loser-key",
            authToken: "loser-token",
            cookie: "auth_token=loser-token; ct0=loser-ct0",
          }),
          undefined,
          racingCommit,
        ),
      ConflictError,
      "X connection changed while reconnecting; retry",
    );

    // The winner's reset state is preserved: the stale request wrote nothing.
    const state = findSourceCredentialStateByConnectorId(
      database,
      user.id,
      ConnectorId.X,
    );
    assertEquals(state?.connected, false);
    assertEquals(state?.credentialRevision, 2);
    assertEquals(
      (await findSourceByConnectorId(database, user.id, ConnectorId.X))
        ?.enabled,
      false,
    );
    const deleted = listFeedsForSource(database, first.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assertEquals(deleted[0].enabled, false);
    assert(deleted[0].deletedAt !== null);
  });
});

test("XSessionService reconnect CAS rejects a competing same-account reconnect and keeps its credentials", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-cas-same@example.com"),
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);

    // The competing same-account reconnect commits between the stale request's
    // snapshot and its commit.
    const racingCommit = async <Result>(operation: () => Result): Promise<Result> => {
      await service.connect(user.id, xInput({
        apiKey: "winner-key",
        authToken: "winner-token",
        cookie: "auth_token=winner-token; ct0=winner-ct0",
      }));
      return await operation();
    };
    await assertRejects(
      () =>
        service.connect(
          user.id,
          xInput({
            apiKey: "loser-key",
            authToken: "loser-token",
            cookie: "auth_token=loser-token; ct0=loser-ct0",
          }),
          undefined,
          racingCommit,
        ),
      ConflictError,
      "X connection changed while reconnecting; retry",
    );

    // Winner's credentials and revision won; the loser's were never written.
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).apiKey,
      "winner-key",
    );
    assertEquals(
      findSourceCredentialStateByConnectorId(database, user.id, ConnectorId.X)
        ?.credentialRevision,
      2,
    );
    // Same-account winner retained the previously committed cache.
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);
  });
});

test("XSessionService reconnect CAS preserves the winner's account reset when a changed-account reconnect wins", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-session-cas-changed@example.com"),
    );
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const first = await service.connect(user.id, xInput());
    const cache = await seedCache(database, first.id);
    seedCatalog(database, first.id);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: first.id,
      externalId: LIST_FEED,
      name: "X List",
      kind: "news",
    });

    // A changed-account reconnect wins the race and resets account-scoped data.
    const racingCommit = async <Result>(operation: () => Result): Promise<Result> => {
      await new XSessionService({
        database,
        credentialCipher: cipher(23),
        validatorFactory: new FakeValidatorFactory(() =>
          Promise.resolve({ userId: "x-user-2", username: "bob" })
        ),
      }).connect(user.id, xInput({
        apiKey: "bob-key",
        authToken: "bob-token",
        cookie: "auth_token=bob-token; ct0=bob-ct0",
      }));
      return await operation();
    };
    await assertRejects(
      () =>
        service.connect(
          user.id,
          xInput({
            apiKey: "loser-key",
            authToken: "loser-token",
            cookie: "auth_token=loser-token; ct0=loser-ct0",
          }),
          undefined,
          racingCommit,
        ),
      ConflictError,
      "X connection changed while reconnecting; retry",
    );

    // Winner's reset state survived: cache cleared, feed soft-deleted, new
    // identity persisted, revision advanced exactly once.
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000), []);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(listFeedsForSource(database, first.id, user.id), []);
    const deleted = listFeedsForSource(database, first.id, user.id, {
      includeDeleted: true,
    });
    assertEquals(deleted.map((entry) => entry.id), [feed.id]);
    assertEquals(deleted[0].enabled, false);
    assert(deleted[0].deletedAt !== null);
    assertEquals(
      xCredentialSchema.parse(
        await getDecryptedCredentials(database, first.id, user.id, cipher(23)),
      ).xUserId,
      "x-user-2",
    );
    assertEquals(
      findSourceCredentialStateByConnectorId(database, user.id, ConnectorId.X)
        ?.credentialRevision,
      2,
    );
  });
});

test("stored X credentials remain opaque ciphertext in the sources table", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("x-session-opaque@example.com"));
    const service = new XSessionService({
      database,
      credentialCipher: cipher(23),
      validatorFactory: new FakeValidatorFactory(() =>
        Promise.resolve({ userId: "x-user-1", username: "alice" })
      ),
    });
    const source = await service.connect(user.id, xInput());

    const row = database
      .select({ credentials: sources.credentials })
      .from(sources)
      .where(eq(sources.id, source.id))
      .get();
    const blob = row?.credentials;
    assertExists(blob);
    const blobText = JSON.stringify(blob);
    for (const secret of [API_KEY, AUTH_TOKEN, COOKIE]) {
      assertEquals(blobText.includes(secret), false, `blob leaked ${secret}`);
    }
    const plaintext = await cipher(23).decrypt(blob, {
      userId: user.id,
      connectorId: ConnectorId.X,
    });
    assertEquals(plaintext.includes(COOKIE), true);
  });
});
