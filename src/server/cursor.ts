import { z } from "zod";
import { ValidationError } from "./errors.ts";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function parseLimit(raw: string | null, defaultLimit = DEFAULT_PAGE_LIMIT): number {
  if (raw === null || raw === undefined) return defaultLimit;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return n;
}

export function parsePageParams(
  url: URL,
  defaultLimit = DEFAULT_PAGE_LIMIT,
): { cursor: string | null; limit: number } {
  const cursor = url.searchParams.get("cursor") || null;
  const limit = parseLimit(url.searchParams.get("limit"), defaultLimit);
  return { cursor, limit };
}

const digestCursorSchema = z.object({
  v: z.literal(1),
  k: z.literal("digest"),
  p: z.number(),
  c: z.number(),
  i: z.string(),
});

const digestRunCursorSchema = z.object({
  v: z.literal(1),
  k: z.literal("run"),
  p: z.number(),
  i: z.string(),
});

export type DigestCursor = z.infer<typeof digestCursorSchema>;
export type DigestRunCursor = z.infer<typeof digestRunCursorSchema>;

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCodePoint(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (s.length % 4);
  if (pad < 4) s += "=".repeat(pad);
  return Uint8Array.from(atob(s), (c) => c.codePointAt(0)!);
}

export function encodeDigestCursor(periodEndMs: number, createdAt: number, id: string): string {
  const payload: DigestCursor = { v: 1, k: "digest", p: periodEndMs, c: createdAt, i: id };
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export function encodeDigestRunCursor(startedAt: number, id: string): string {
  const payload: DigestRunCursor = { v: 1, k: "run", p: startedAt, i: id };
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeDigestCursor(raw: string): DigestCursor {
  try {
    const json = new TextDecoder().decode(base64UrlDecode(raw));
    return digestCursorSchema.parse(JSON.parse(json));
  } catch {
    throw new ValidationError("Invalid cursor");
  }
}

export function decodeDigestRunCursor(raw: string): DigestRunCursor {
  try {
    const json = new TextDecoder().decode(base64UrlDecode(raw));
    return digestRunCursorSchema.parse(JSON.parse(json));
  } catch {
    throw new ValidationError("Invalid cursor");
  }
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}
