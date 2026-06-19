import type { Context } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { encodeBase64Url } from "@std/encoding/base64url";
import { encodeHex } from "@std/encoding/hex";
import type { Database } from "../db/client.ts";
import {
  createSession as persistSession,
  deleteSessionByTokenHash,
  findValidSessionByTokenHash,
} from "../repositories/session-repository.ts";

export const SESSION_COOKIE = "session";

const TOKEN_BYTE_LENGTH = 32;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  return encodeHex(new Uint8Array(digest));
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
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
  const token = encodeBase64Url(bytes);
  const tokenHash = await hashToken(token);
  const expiresAt = Date.now() + ttlMs;
  await persistSession(database, { userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Resolves a raw token to its owner's `userId` if a non-expired session matches
 * its hash; otherwise null.
 */
export async function validateSessionToken(
  database: Database,
  token: string,
  now: number,
): Promise<string | null> {
  const tokenHash = await hashToken(token);
  const session = await findValidSessionByTokenHash(database, tokenHash, now);
  return session ? session.userId : null;
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
