import { ConnectorId } from "../../constants.ts";
import { CredentialCipher } from "../../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../crypto/key-provider.ts";
import type { Database } from "../../db/client.ts";
import { upsertSourceCredentials } from "../../repositories/source-repository.ts";
import { AppError, ConflictError, NotFoundError } from "../../server/errors.ts";
import {
  type DestroyableTelegramClient,
  destroyTelegramClient,
  readTelegramApiCredentials,
  type TelegramApiCredentials,
} from "./client-factory.ts";

const LOGIN_SESSION_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT_LOGIN_SESSIONS_PER_USER = 3;
const SAFE_LOGIN_ERROR_MESSAGE = "Telegram login failed";

export type TelegramLoginStatus =
  | "pending"
  | "needs_2fa"
  | "complete"
  | "error"
  | "expired";

type PasswordResolver = (password: string) => void;

export interface TelegramLoginClient extends DestroyableTelegramClient {
  session: {
    save(): string;
  };
  signInUserWithQrCode(
    credentials: TelegramApiCredentials,
    callbacks: {
      qrCode(
        code: { token: { toString(encoding: "base64url"): string } },
      ): Promise<void>;
      password(): Promise<string>;
      onError(error: unknown): Promise<boolean>;
    },
  ): Promise<void>;
}

export interface TelegramLoginClientFactory {
  createUnauthenticatedClient(): Promise<TelegramLoginClient>;
  readApiCredentials(): TelegramApiCredentials;
}

export interface TelegramLoginSessionStatus {
  status: TelegramLoginStatus;
  qrUrl?: string;
  errorMessage?: string;
  expiresAt: number;
}

interface TelegramLoginSession {
  id: string;
  userId: string;
  client: TelegramLoginClient | null;
  status: TelegramLoginStatus;
  qrUrl: string | null;
  errorMessage: string | null;
  expiresAt: number;
  sessionString: string | null;
  passwordResolver: PasswordResolver | null;
  sourcePersisted: boolean;
  authorizationFlow: Promise<void> | null;
}

export interface TelegramLoginSessionDebugSnapshot {
  status: TelegramLoginStatus;
  hasClient: boolean;
  hasSessionString: boolean;
}

export interface TelegramLoginSessionManagerDependencies {
  database: Database;
  credentialCipher: CredentialCipher;
  clientFactory?: TelegramLoginClientFactory;
  now?: () => number;
}

class DefaultTelegramLoginClientFactory implements TelegramLoginClientFactory {
  async createUnauthenticatedClient(): Promise<TelegramLoginClient> {
    try {
      // Deliberately lazy: the Telegram client factory loads GramJS only when login starts.
      const { createUnauthenticatedTelegramClient } = await import(
        "./client-factory.ts"
      );
      return await createUnauthenticatedTelegramClient() as unknown as TelegramLoginClient;
    } catch (error) {
      throw new Error("Failed to load Telegram login client factory", {
        cause: error,
      });
    }
  }

  readApiCredentials(): TelegramApiCredentials {
    return readTelegramApiCredentials();
  }
}

export class TelegramLoginSessionManager {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #clientFactory: TelegramLoginClientFactory;
  readonly #now: () => number;
  readonly #sessions = new Map<string, TelegramLoginSession>();

  constructor(dependencies: TelegramLoginSessionManagerDependencies) {
    this.#database = dependencies.database;
    this.#credentialCipher = dependencies.credentialCipher;
    this.#clientFactory = dependencies.clientFactory ??
      new DefaultTelegramLoginClientFactory();
    this.#now = dependencies.now ?? Date.now;
  }

  async startLogin(
    userId: string,
  ): Promise<{ loginSessionId: string; qrUrl: string; expiresAt: number }> {
    await this.#reapExpiredSessions();
    this.#enforceConcurrentSessionLimit(userId);

    const session = this.#createSession(userId, null);
    this.#sessions.set(session.id, session);

    try {
      session.client = await this.#clientFactory.createUnauthenticatedClient();
      await this.#ensureReservationIsLive(session);
      const qrUrlPromise = this.#startAuthorizationFlow(session);
      const qrUrl = await qrUrlPromise;

      return {
        loginSessionId: session.id,
        qrUrl,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      await this.#disposeSession(session);
      this.#sessions.delete(session.id);
      throw error;
    }
  }

  async getStatus(
    id: string,
    userId: string,
  ): Promise<TelegramLoginSessionStatus> {
    const session = this.#findOwnedSession(id, userId);
    if (await this.#expireSessionIfNeeded(session)) {
      return { status: "expired", expiresAt: session.expiresAt };
    }
    return this.#toStatus(session);
  }

  async submitTwoFactorAuthentication(
    id: string,
    userId: string,
    password: string,
  ): Promise<TelegramLoginSessionStatus> {
    const session = this.#findOwnedSession(id, userId);
    if (await this.#expireSessionIfNeeded(session)) {
      throw new ConflictError("telegram login session expired");
    }
    if (session.status !== "needs_2fa" || session.passwordResolver === null) {
      throw new ConflictError(
        "telegram login session is not waiting for two-factor authentication",
      );
    }

    const resolvePassword = session.passwordResolver;
    session.passwordResolver = null;
    resolvePassword(password);
    await session.authorizationFlow;
    return this.#toStatus(session);
  }

  async consumeCompletedSession(id: string, userId: string): Promise<string> {
    const session = this.#findOwnedSession(id, userId);
    if (await this.#expireSessionIfNeeded(session)) {
      throw new ConflictError("telegram login session expired");
    }
    if (session.status !== "complete" || session.sessionString === null) {
      throw new ConflictError("telegram login session is not complete");
    }

    const sessionString = session.sessionString;
    await this.#disposeSession(session);
    this.#sessions.delete(id);
    return sessionString;
  }

  debugSnapshotForTesting(
    id: string,
    userId: string,
  ): TelegramLoginSessionDebugSnapshot | null {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      return null;
    }
    return {
      status: session.status,
      hasClient: session.client !== null,
      hasSessionString: session.sessionString !== null,
    };
  }

  #createSession(
    userId: string,
    client: TelegramLoginClient | null,
  ): TelegramLoginSession {
    return {
      id: crypto.randomUUID(),
      userId,
      client,
      status: "pending",
      qrUrl: null,
      errorMessage: null,
      expiresAt: this.#now() + LOGIN_SESSION_TTL_MS,
      sessionString: null,
      passwordResolver: null,
      sourcePersisted: false,
      authorizationFlow: null,
    };
  }

  async #ensureReservationIsLive(session: TelegramLoginSession): Promise<void> {
    if (
      session.expiresAt > this.#now() &&
      this.#sessions.get(session.id) === session
    ) {
      return;
    }

    await this.#terminalizeExpiredSession(session);
    this.#sessions.delete(session.id);
    throw new ConflictError("telegram login session expired");
  }

  #startAuthorizationFlow(session: TelegramLoginSession): Promise<string> {
    const {
      promise: qrUrlPromise,
      resolve: resolveQrUrl,
      reject: rejectQrUrl,
    } = Promise.withResolvers<string>();

    const client = session.client;
    if (client === null) {
      rejectQrUrl(new Error(SAFE_LOGIN_ERROR_MESSAGE));
      return qrUrlPromise;
    }
    const credentials = this.#clientFactory.readApiCredentials();
    session.authorizationFlow = client.signInUserWithQrCode(credentials, {
      qrCode: (code) => {
        const qrUrl = `tg://login?token=${code.token.toString("base64url")}`;
        session.qrUrl = qrUrl;
        resolveQrUrl(qrUrl);
        return Promise.resolve();
      },
      password: async () =>
        await this.#waitForTwoFactorAuthenticationPassword(session),
      onError: async () => {
        await this.#markSessionError(session);
        rejectQrUrl(new Error(SAFE_LOGIN_ERROR_MESSAGE));
        return true;
      },
    }).then(async () => {
      await this.#markSessionComplete(session);
    }).catch(async () => {
      await this.#markSessionError(session);
      rejectQrUrl(new Error(SAFE_LOGIN_ERROR_MESSAGE));
    });

    return qrUrlPromise;
  }

  async #waitForTwoFactorAuthenticationPassword(
    session: TelegramLoginSession,
  ): Promise<string> {
    session.status = "needs_2fa";
    const { promise, resolve } = Promise.withResolvers<string>();
    session.passwordResolver = resolve;
    return await promise;
  }

  async #markSessionComplete(session: TelegramLoginSession): Promise<void> {
    if (session.status === "expired") {
      return;
    }
    if (session.client === null) {
      return;
    }
    session.sessionString = session.client.session.save();
    if (session.expiresAt <= this.#now()) {
      await this.#terminalizeExpiredSession(session);
      return;
    }
    await this.#persistCompletedSession(session);
    session.status = "complete";
    await this.#disposeSession(session);
    session.passwordResolver = null;
  }

  async #persistCompletedSession(session: TelegramLoginSession): Promise<void> {
    if (session.sourcePersisted || session.sessionString === null) {
      return;
    }

    const credentials = await this.#credentialCipher.encrypt(
      JSON.stringify({ sessionString: session.sessionString }),
      { userId: session.userId, connectorId: ConnectorId.Telegram },
    );
    await upsertSourceCredentials(this.#database, {
      userId: session.userId,
      connectorId: ConnectorId.Telegram,
      credentials,
    });
    session.sourcePersisted = true;
  }

  async #markSessionError(session: TelegramLoginSession): Promise<void> {
    if (session.status === "expired" || session.status === "complete") {
      return;
    }
    session.status = "error";
    session.errorMessage = SAFE_LOGIN_ERROR_MESSAGE;
    session.passwordResolver = null;
    await this.#disposeSession(session);
  }

  #enforceConcurrentSessionLimit(userId: string): void {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.userId === userId && this.#isActiveSession(session)) {
        count += 1;
      }
    }
    if (count >= MAX_CONCURRENT_LOGIN_SESSIONS_PER_USER) {
      throw new AppError(429, "too many active telegram login sessions");
    }
  }

  #findOwnedSession(id: string, userId: string): TelegramLoginSession {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new NotFoundError("telegram login session not found");
    }
    return session;
  }

  async #reapExpiredSessions(): Promise<void> {
    const now = this.#now();
    const expiredSessions = [...this.#sessions.values()].filter((session) =>
      session.expiresAt <= now
    );
    await Promise.all(
      expiredSessions.map((session) => this.#disposeExpiredSession(session)),
    );
  }

  async #expireSessionIfNeeded(
    session: TelegramLoginSession,
  ): Promise<boolean> {
    if (session.expiresAt > this.#now()) {
      return false;
    }
    await this.#disposeExpiredSession(session);
    return true;
  }

  async #terminalizeExpiredSession(
    session: TelegramLoginSession,
  ): Promise<void> {
    session.status = "expired";
    session.passwordResolver = null;
    await this.#disposeSession(session);
  }

  async #disposeExpiredSession(session: TelegramLoginSession): Promise<void> {
    await this.#terminalizeExpiredSession(session);
    this.#sessions.delete(session.id);
  }

  async #disposeSession(session: TelegramLoginSession): Promise<void> {
    const client = session.client;
    session.client = null;
    try {
      if (client !== null) {
        await destroyTelegramClient(client);
      }
    } finally {
      session.sessionString = null;
      session.qrUrl = null;
    }
  }

  #isActiveSession(session: TelegramLoginSession): boolean {
    return session.status === "pending" || session.status === "needs_2fa";
  }

  #toStatus(session: TelegramLoginSession): TelegramLoginSessionStatus {
    return {
      status: session.status,
      ...(session.qrUrl === null ? {} : { qrUrl: session.qrUrl }),
      ...(session.errorMessage === null
        ? {}
        : { errorMessage: session.errorMessage }),
      expiresAt: session.expiresAt,
    };
  }
}

export function createDefaultTelegramLoginSessionManager(
  database: Database,
): TelegramLoginSessionManager {
  return new TelegramLoginSessionManager({
    database,
    credentialCipher: new CredentialCipher(new EnvMasterKeyProvider()),
  });
}
