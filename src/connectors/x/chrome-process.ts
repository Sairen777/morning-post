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
  let spawned = false;
  let termination: Promise<void> | undefined;
  // `exited` settles successfully only on a confirmed child exit after spawn.
  // The durable error listener guarantees a post-spawn ChildProcess error
  // (e.g. a failed kill) can never surface as an unhandled `error` event, even
  // across retried terminations; it neither marks the process stopped nor
  // settles `exited`, which stays retryable.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      running = false;
      resolve();
    });
    child.on("error", () => {
      if (!spawned) running = false;
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    child.once("error", reject);
  });

  const waitBounded = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  const signalOrThrow = async (signal: NodeJS.Signals): Promise<void> => {
    if (child.kill(signal)) return;
    // The signal was not delivered (commonly the child was reaped between the
    // exit event and this kill). Give the exit event one tick to confirm
    // before treating the failed signal as terminal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (running) {
      throw new Error(`X Chrome process could not be signaled (${signal})`);
    }
  };

  return {
    get running() {
      return running;
    },
    exited,
    terminate() {
      termination ??= (async () => {
        try {
          if (!running) {
            await exited;
            return;
          }
          await signalOrThrow("SIGTERM");
          await waitBounded(TERMINATE_GRACE_MS);
          if (!running) return;
          await signalOrThrow("SIGKILL");
          await waitBounded(TERMINATE_GRACE_MS);
          if (running) {
            throw new Error(
              "X Chrome process did not exit after SIGTERM and SIGKILL",
            );
          }
        } catch (error) {
          termination = undefined; // permit a later retry
          throw error;
        }
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
