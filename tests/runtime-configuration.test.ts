import { test } from "bun:test";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { CONNECTORS_MEDIA_DIR } from "../src/constants.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "./assertions.ts";

type RootPackage = {
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

async function readRootPackage(): Promise<RootPackage> {
  return JSON.parse(await readFile("./package.json", "utf8")) as RootPackage;
}

test("root package pins Bun as its runtime and package manager", async () => {
  const packageJson = await readRootPackage();
  assertEquals(packageJson.packageManager, "bun@1.3.14");
  assertEquals(packageJson.engines?.bun, "1.3.14");
});

test("operational scripts validate and load the production environment", async () => {
  const scripts = (await readRootPackage()).scripts;
  assert(scripts, "root package must define scripts");

  for (
    const scriptName of [
      "dev:cli",
      "db:generate",
      "db:migrate",
      "db:cleanup",
      "db:reset",
      "dev:api",
      "start",
      "e2e:api",
      "e2e:db:cleanup",
      "test:analysis:live",
      "capture-fixtures",
    ]
  ) {
    const command = scripts[scriptName];
    assert(command, `root package must define the ${scriptName} script`);
    assert(
      command.startsWith("bun run env:check && "),
      `${scriptName} must validate .env.production.local first`,
    );
    assert(
      command.split(/\s+/).includes("--env-file=.env.production.local"),
      `${scriptName} must load .env.production.local explicitly`,
    );
  }
});

test("ordinary unit tests do not depend on production environment files", async () => {
  const scripts = (await readRootPackage()).scripts;
  assert(scripts, "root package must define scripts");
  assertEquals(scripts.test, "bun test tests");
});

test("runtime scheduler and HTTP server dependencies are production dependencies", async () => {
  const dependencies = (await readRootPackage()).dependencies;
  assert(dependencies, "root package must define production dependencies");
  assertEquals(dependencies.croner, "10.0.1");
  assertEquals(dependencies.hono, "4.12.19");
});

test("production shell delegates to the Bun start script", async () => {
  const shell = await readFile(
    "./scripts/production-start.template.sh",
    "utf8",
  );
  const commands = shell
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  assertStringIncludes(commands.at(-1) ?? "", "exec bun");
  assertEquals(commands.at(-1)?.split(/\s+/), [
    "exec",
    "bun",
    "--env-file=.env.production.local",
    "run",
    "start",
  ]);
});

test("every connector media directory is writable by the Bun process", async () => {
  for (const directory of Object.values(CONNECTORS_MEDIA_DIR)) {
    await mkdir(directory, { recursive: true });
    await access(directory, fsConstants.W_OK);

    const probe = `${directory}/.bun-write-probe-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(probe, "writable", { flag: "wx" });
      assertEquals(await readFile(probe, "utf8"), "writable");
    } finally {
      await rm(probe, { force: true });
    }
  }
});
