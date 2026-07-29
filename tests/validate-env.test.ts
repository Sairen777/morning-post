import { test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "./assertions.ts";

const VALIDATOR_PATH = resolve(import.meta.dir, "../scripts/validate-env.ts");

async function run(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "morning-post-env-contract-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("environment validator compares assignment keys across common dotenv syntax", async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(
      join(directory, ".env.example"),
      [
        "# documented values do not matter",
        "PLAIN=example-secret-value",
        " export EXPORTED = example-exported-secret ",
        "SPACED = example-spaced-secret",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(directory, ".env.production.local"),
      [
        "# production comments and values may differ",
        "SPACED=production-spaced-secret",
        "export EXPORTED=production-exported-secret",
        "  PLAIN = production-secret-value",
        "EXTRA_KEY=allowed-extra-secret",
        "",
      ].join("\n"),
    );

    const result = await run(["bun", VALIDATOR_PATH], directory);
    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.output, "contains every key");
    for (const secret of [
      "example-secret-value",
      "example-exported-secret",
      "production-secret-value",
      "allowed-extra-secret",
    ]) {
      assert(!result.output.includes(secret), `validator exposed ${secret}`);
    }
  });
});

test("environment validator reports only missing key names", async () => {
  await withTemporaryDirectory(async (directory) => {
    const exampleSecret = "example-value-must-stay-private";
    const productionSecret = "production-value-must-stay-private";
    await writeFile(
      join(directory, ".env.example"),
      `PRESENT=${exampleSecret}\nMISSING_SECRET=${exampleSecret}\n`,
    );
    await writeFile(
      join(directory, ".env.production.local"),
      `PRESENT=${productionSecret}\nEXTRA=${productionSecret}\n`,
    );

    const result = await run(["bun", VALIDATOR_PATH], directory);
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.output, "MISSING_SECRET");
    assert(!result.output.includes(exampleSecret));
    assert(!result.output.includes(productionSecret));
    assert(!result.output.includes("PRESENT="));
  });
});

test("ordinary test script runs without a production environment file", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "tests"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { test: "bun test tests" } }),
    );
    await writeFile(
      join(directory, "tests", "smoke.test.ts"),
      'import { expect, test } from "bun:test";\ntest("smoke", () => expect(2 + 2).toBe(4));\n',
    );

    const result = await run(["bun", "run", "test"], directory);
    assertEquals(result.exitCode, 0, result.output);
    assertStringIncludes(result.output, "1 pass");
  });
});
