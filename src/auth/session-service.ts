import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "../db/client.ts";
import {
  createSession as persistSession,
  deleteSessionByTokenHash,
  findValidSessionByTokenHash,
  touchSessionIfDue,
} from "../repositories/session-repository.ts";

export const SESSION_COOKIE = "__Host-session";

const TOKEN_BYTE_LENGTH = 32;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cookie attributes shared by set/clear. `httpOnly` keeps the token out of
 * JavaScript, `secure` confines it to HTTPS, `sameSite: "Lax"` blocks
 * cross-site sends while allowing top-level navigation, and `path: "/"` scopes
 * it to the whole API.
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

/** SHA-256 of the raw token, hex-encoded. Only this is ever persisted. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString("hex");
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
}

export interface ValidatedSession {
  userId: string;
  token: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
}

/**
 * Mints a fresh session: a random 256-bit base64url token handed back for the
 * cookie, with only its hash persisted. `ttlMs` defaults to 30 days.
 */
export async function createSession(
  database: Database,
  userId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<CreatedSession> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  const token = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64url");
  const tokenHash = await hashToken(token);
  const expiresAt = Date.now() + ttlMs;
  await persistSession(database, { userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Resolves a raw token and records activity without rotating the bearer token.
 * Near the idle boundary, the existing session is atomically extended.
 */
export async function validateSessionToken(
  database: Database,
  token: string,
  now: number,
): Promise<ValidatedSession | null> {
  const tokenHash = await hashToken(token);
  const session = await findValidSessionByTokenHash(database, tokenHash, now);
  if (!session) {
    return null;
  }

  const nextExpiresAt = session.expiresAt - now <= SESSION_REFRESH_WINDOW_MS
    ? now + DEFAULT_SESSION_TTL_MS
    : session.expiresAt;
  const touched = await touchSessionIfDue(
    database,
    session.id,
    now,
    nextExpiresAt,
    SESSION_TOUCH_INTERVAL_MS,
  );
  const expiresAt = touched?.expiresAt ?? session.expiresAt;
  return {
    userId: session.userId,
    token,
    expiresAt,
    refreshExpiresAt: expiresAt > session.expiresAt ? expiresAt : null,
  };
}

/** Deletes the session matching the raw token (no-op if none matches). */
export async function revokeSessionToken(
  database: Database,
  token: string,
): Promise<void> {
  const tokenHash = await hashToken(token);
  await deleteSessionByTokenHash(database, tokenHash);
}

export function setSessionCookie(
  context: Context,
  token: string,
  expiresAt: number,
): void {
  setCookie(context, SESSION_COOKIE, token, {
    ...COOKIE_OPTIONS,
    expires: new Date(expiresAt),
  });
}

export function readSessionToken(context: Context): string | undefined {
  return getCookie(context, SESSION_COOKIE);
}

export function clearSessionCookie(context: Context): void {
  deleteCookie(context, SESSION_COOKIE, COOKIE_OPTIONS);
}
