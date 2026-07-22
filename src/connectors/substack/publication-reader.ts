import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { requestPinnedHttps } from "./pinned-https.ts";

const MAX_URL_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ResolveDns = (
  host: string,
  recordType: "A" | "AAAA",
  signal?: AbortSignal,
) => Promise<string[]>;
type PinnedRequest = (
  url: URL,
  addresses: string[],
  signal?: AbortSignal,
) => Promise<Response>;

export interface PublicationReaderDependencies {
  fetch?: FetchLike;
  resolveDns?: ResolveDns;
  pinnedRequest?: PinnedRequest;
}

export interface ArchiveItem {
  id: number;
  type: string;
  title: string;
  postDate: number;
  audience?: string;
  truncatedBodyText?: string;
  description?: string;
  subtitle?: string;
  canonicalUrl?: string;
  publishedBylines?: Array<{ name?: string }>;
  publicationName?: string;
  publicationId: number;
  raw: Record<string, unknown>;
}

export interface PublicArchivePage {
  origin: string;
  items: ArchiveItem[];
}

export function normalizePublicationUrl(input: string): string {
  if (input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new Error("publication URL is invalid");
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const authority = withScheme.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
  const authorityHost = authority.replace(/^(?:[^@]*@)/, "").replace(/^\[|\]$/g, "");
  if (/^(?:\d+|0x[\da-f]+)$/i.test(authorityHost) || /:/.test(authorityHost)) {
    throw new Error("publication URL host must be a domain");
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("publication URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("publication URL must be HTTPS without credentials or a custom port");
  }
  if (!url.hostname || url.hostname === "localhost" || ipLiteral(url.hostname)) {
    throw new Error("publication URL host must be a domain");
  }
  return url.origin;
}

function ipLiteral(hostname: string): boolean {
  try {
    ipaddr.parse(hostname);
    return true;
  } catch {
    return false;
  }
}

async function resolvePublicHost(
  host: string,
  resolver: ResolveDns,
  signal?: AbortSignal,
): Promise<string[]> {
  const addressResults = await Promise.all([
    resolver(host, "A", signal),
    resolver(host, "AAAA", signal),
  ]);
  const addresses = addressResults.flat();
  if (addresses.length === 0 || addresses.some((address) => !isGlobalUnicast(address))) {
    throw new Error("publication host does not resolve to public addresses");
  }
  return addresses;
}

async function resolveAddressFamily(
  host: string,
  recordType: "A" | "AAAA",
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw abortReason(signal);
  try {
    const lookup = recordType === "A" ? resolve4(host) : resolve6(host);
    return await abortableDnsLookup(lookup, signal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (isDnsNotFoundError(error)) return [];
    throw error;
  }
}

async function abortableDnsLookup(
  lookup: Promise<string[]>,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!signal) return await lookup;
  const { promise, resolve, reject } = Promise.withResolvers<string[]>();
  const onAbort = () => reject(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  lookup.then(
    (addresses) => {
      signal.removeEventListener("abort", onAbort);
      resolve(addresses);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    },
  );
  if (signal.aborted) onAbort();
  return await promise;
}

export function isDnsNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

function isGlobalUnicast(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address()
      : parsed;
    return normalized.range() === "unicast";
  } catch {
    return false;
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      throw abortReason(signal);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response exceeds byte limit");
        throw new Error("response exceeds byte limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

export function validateArchivePage(body: string): ArchiveItem[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Substack archive response is invalid JSON");
  }
  if (!Array.isArray(value)) {
    throw new Error("Substack archive response is not an array");
  }
  if (value.length === 0) return [];
  const items = value.map(parseArchiveItem);
  return items;
}

function parseArchiveItem(value: unknown): ArchiveItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Substack archive item is invalid");
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  const publicationId = raw.publication_id;
  const title = raw.title;
  const type = raw.type;
  const postDate = raw.post_date;
  if (
    typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
    typeof publicationId !== "number" || !Number.isSafeInteger(publicationId) || publicationId <= 0 ||
    typeof title !== "string" || title.trim() === "" ||
    typeof type !== "string" || type.trim() === "" ||
    typeof postDate !== "string" || !Number.isFinite(Date.parse(postDate))
  ) {
    throw new Error("Substack archive item is invalid");
  }
  const bylines = Array.isArray(raw.publishedBylines)
    ? raw.publishedBylines.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    : [];
  const publicationUsers = Array.isArray(bylines[0]?.publicationUsers)
    ? bylines[0].publicationUsers as unknown[]
    : [];
  const firstPublicationUser = publicationUsers.find(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
  );
  const publication = firstPublicationUser?.publication;
  const publicationRecord = publication && typeof publication === "object"
    ? publication as Record<string, unknown>
    : undefined;
  return {
    id,
    type,
    title: title.trim(),
    postDate: Date.parse(postDate),
    audience: typeof raw.audience === "string" ? raw.audience : undefined,
    truncatedBodyText: stringValue(raw.truncated_body_text),
    description: stringValue(raw.description),
    subtitle: stringValue(raw.subtitle),
    canonicalUrl: stringValue(raw.canonical_url),
    publishedBylines: bylines.map((entry) => ({
      name: stringValue(entry.name),
    })),
    publicationName: stringValue(publicationRecord?.name) ?? stringValue(raw.publication_name),
    publicationId,
    raw,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function readPublicArchive(
  publicationUrl: string,
  dependencies: PublicationReaderDependencies = {},
  offset = 0,
  limit = 50,
  signal?: AbortSignal,
): Promise<PublicArchivePage> {
  const fetcher = dependencies.fetch;
  const pinnedRequest = dependencies.pinnedRequest ?? requestPinnedHttps;
  const resolver = dependencies.resolveDns ?? resolveAddressFamily;
  let origin = normalizePublicationUrl(publicationUrl);
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (signal?.aborted) throw abortReason(signal);
    const url = `${origin}/api/v1/archive?sort=new&search=&offset=${offset}&limit=${limit}`;
    if (visited.has(url)) throw new Error("Substack archive redirect loop");
    visited.add(url);
    const addresses = await resolvePublicHost(new URL(origin).hostname, resolver, signal);
    const response = fetcher
      ? await fetcher(url, { redirect: "manual", signal })
      : await pinnedRequest(new URL(url), addresses, signal);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new Error("Substack archive redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location) throw new Error("Substack archive redirect has no location");
      const next = new URL(location, url);
      origin = normalizePublicationUrl(next.origin);
      continue;
    }
    if (!response.ok) throw new Error(`Substack archive request failed with status ${response.status}`);
    const body = new TextDecoder().decode(await readBoundedResponse(response, MAX_RESPONSE_BYTES, signal));
    const items = validateArchivePage(body);
    const firstPublicationName = items.find((item) => item.publicationName)?.publicationName;
    return { origin, items: items.map((item) => ({ ...item, publicationName: item.publicationName ?? firstPublicationName })) };
  }
  throw new Error("Substack archive redirect limit exceeded");
}
