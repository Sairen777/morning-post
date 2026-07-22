import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function globalTeardown(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const child = spawn("bun", ["run", "e2e:db:cleanup"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) {
    throw new Error(
      `E2E database cleanup failed with status ${String(status)}`,
    );
  }
}
