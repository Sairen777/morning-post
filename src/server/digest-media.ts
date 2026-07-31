import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Media } from "../connectors/connector.types.ts";
import { ConnectorId, CONNECTORS_MEDIA_DIR } from "../constants.ts";
import type { Database } from "../db/client.ts";
import { findDigestById } from "../repositories/digest-repository.ts";
import { findItemById } from "../repositories/item-repository.ts";
import { listDigestStories } from "../repositories/story-repository.ts";
import { NotFoundError } from "./errors.ts";

/** Media files are written under these extensions by the connectors. */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

function localMediaPaths(media: Media | undefined): string[] {
  if (media?.type === "photo") return [media.localPath];
  if (media?.type === "album") return [...media.localPaths];
  return [];
}

function contentTypeForPath(path: string): string | null {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return IMAGE_CONTENT_TYPES[extension] ?? null;
}

/**
 * Resolves a connector-stored relative media path to the canonical absolute
 * path of an existing regular file, or null when the path is unsafe or
 * unavailable. Two containment gates apply:
 *
 * 1. Lexical: the path must be relative and resolve inside the connector's
 *    media root, blocking `..` escapes and absolute paths.
 * 2. Canonical: the symlink-resolved target must still lie inside the
 *    realpath'd connector media root, so an in-root symlink cannot point
 *    media serving outside the root. Missing or broken links yield null.
 */
async function resolveCanonicalMediaPath(
  connectorId: ConnectorId,
  localPath: string,
  canonicalMediaRoot: string,
): Promise<string | null> {
  const rootDir = CONNECTORS_MEDIA_DIR[connectorId];
  if (!rootDir || isAbsolute(localPath)) return null;
  const cwd = process.cwd();
  const mediaRoot = resolve(cwd, rootDir);
  const candidate = resolve(cwd, localPath);
  if (candidate !== mediaRoot && !candidate.startsWith(mediaRoot + sep)) {
    return null;
  }
  try {
    const canonicalCandidate = await realpath(candidate);
    if (
      canonicalCandidate !== canonicalMediaRoot &&
      !canonicalCandidate.startsWith(canonicalMediaRoot + sep)
    ) {
      return null;
    }
    const fileStat = await stat(canonicalCandidate);
    if (!fileStat.isFile()) return null;
    return canonicalCandidate;
  } catch {
    return null;
  }
}

/**
 * Serves the persisted media of a story item attached to one of the user's
 * digests. The digest must belong to the session user and the item must be
 * referenced by the digest's stories (searched in display order) before any
 * file is resolved or read.
 */
export async function serveDigestItemMedia(
  database: Database,
  userId: string,
  digestId: string,
  itemId: string,
): Promise<Response> {
  const digest = findDigestById(database, digestId, userId);
  if (!digest) {
    throw new NotFoundError("digest not found");
  }

  // Stories are ordered by generatedAt and sources keep their attachment
  // order, so the first matching source is the item's display position.
  const stories = listDigestStories(database, userId, digestId);
  const member = stories
    .flatMap((story) => story.sources)
    .find((source) => source.itemId === itemId);
  if (!member) {
    throw new NotFoundError("media not found");
  }

  const item = findItemById(database, itemId);
  if (!item) {
    throw new NotFoundError("media not found");
  }

  const rootDir = CONNECTORS_MEDIA_DIR[item.payload.connectorId];
  let canonicalMediaRoot: string | null = null;
  if (rootDir) {
    try {
      canonicalMediaRoot = await realpath(resolve(process.cwd(), rootDir));
    } catch {
      canonicalMediaRoot = null;
    }
  }

  if (canonicalMediaRoot) {
    for (const localPath of localMediaPaths(item.payload.media)) {
      const candidate = await resolveCanonicalMediaPath(
        item.payload.connectorId,
        localPath,
        canonicalMediaRoot,
      );
      if (!candidate) continue;
      const contentType = contentTypeForPath(candidate);
      if (!contentType) continue;
      return new Response(Bun.file(candidate), {
        headers: {
          "content-type": contentType,
          // Auth-gated user-owned media: no-store keeps it out of shared and
          // private caches so a response can never outlive the session that
          // authorized it (logout, revocation, or account switch).
          "cache-control": "private, no-store",
        },
      });
    }
  }

  throw new NotFoundError("media not found");
}
