import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface XChromeProcess {
  readonly exited: Promise<void>;
  readonly running: boolean;
  terminate(): Promise<void>;
}

export type XChromeProcessLauncher = (
  executable: string,
  argv: readonly string[],
) => Promise<XChromeProcess>;

const TERMINATE_GRACE_MS = 3_000;

export async function resolveStableChromeExecutable(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const candidates = chromeInstallationPaths(platform);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation path.
    }
  }
  throw new Error("Google Chrome is not installed in a standard location");
}

export async function launchChromeProcess(
  executable: string,
  argv: readonly string[],
): Promise<XChromeProcess> {
  const child = spawn(executable, [...argv], {
    shell: false,
    stdio: "ignore",
    detached: false,
  });
  let running = true;
  let termination: Promise<void> | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      running = false;
      reject(error);
    });
    child.once("exit", () => {
      running = false;
      resolve();
    });
  });
  void exited.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  return {
    get running() {
      return running;
    },
    exited,
    terminate() {
      termination ??= (async () => {
        if (!running) {
          await exited;
          return;
        }
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, TERMINATE_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        if (running) child.kill("SIGKILL");
        await exited;
      })();
      return termination;
    },
  };
}

function chromeInstallationPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (platform === "win32") {
    return [
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    ].filter((path): path is string => Boolean(path));
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/google-chrome",
  ];
}
