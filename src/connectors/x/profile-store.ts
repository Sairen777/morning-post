import {
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { throwIfAborted } from "./abort.ts";

const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class XProfileStore {
  public readonly root: string;

  constructor(profileRoot: string) {
    if (typeof profileRoot !== "string" || profileRoot.trim() === "") {
      throw new Error("X profile root is required");
    }
    const requestedRoot = resolve(profileRoot);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(requestedRoot);
    if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
      throw new Error("X profile root must be a directory");
    }
    this.root = realpathSync(requestedRoot);
  }

  public pathFor(profileId: string): string {
    if (!OWNER_UUID.test(profileId)) {
      throw new Error("X profile ID must be a canonical lowercase UUID");
    }
    const profilePath = resolve(this.root, profileId);
    assertContained(this.root, profilePath);
    return profilePath;
  }

  public async ensure(profileId: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const profilePath = this.pathFor(profileId);
    try {
      await mkdir(profilePath, { mode: 0o700 });
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) throw error;
    }

    return await this.resolveOwnedDirectory(profilePath, signal);
  }

  public async requireExisting(profileId: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    return await this.resolveOwnedDirectory(this.pathFor(profileId), signal);
  }

  private async resolveOwnedDirectory(
    profilePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const profileStat = await lstat(profilePath);
    if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) {
      throw new Error("X profile path must be an app-owned directory, not a link");
    }
    const canonicalProfilePath = await realpath(profilePath);
    assertContained(this.root, canonicalProfilePath);
    await chmod(canonicalProfilePath, 0o700);
    throwIfAborted(signal);
    return canonicalProfilePath;
  }

  public async remove(profileId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const profilePath = this.pathFor(profileId);
    let profileStat;
    try {
      profileStat = await lstat(profilePath);
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw error;
    }

    throwIfAborted(signal);
    if (profileStat.isSymbolicLink()) {
      await unlink(profilePath);
    } else {
      await rm(profilePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  }
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error("X profile path escapes the configured profile root");
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
