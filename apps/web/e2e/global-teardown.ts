import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalTeardown(): void {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const result = spawnSync("deno", ["task", "e2e:db:cleanup"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `E2E database cleanup failed with status ${String(result.status)}`,
    );
  }
}
