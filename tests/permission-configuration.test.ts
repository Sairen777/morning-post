import { assertEquals } from "@std/assert";
import { CONNECTORS_MEDIA_DIR } from "../src/constants.ts";

const MEDIA_PATHS = [
  ...Object.values(CONNECTORS_MEDIA_DIR).map((path) => `./${path}`),
  "./media",
] as const;

type PermissionProfile = {
  net?: boolean | string[];
  sys?: boolean | string[];
  read?: string[];
  write?: string[];
};

Deno.test("media-reading runtime profiles grant read and write access to every media directory", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json")) as {
    permissions: Record<string, PermissionProfile>;
  };

  for (const profileName of ["api", "cli", "test"]) {
    const profile = denoConfig.permissions[profileName];
    assertEquals(
      MEDIA_PATHS.filter((path) => !profile?.read?.includes(path)),
      [],
      `${profileName} read permissions must include every media directory`,
    );
    assertEquals(
      MEDIA_PATHS.filter((path) => !profile?.write?.includes(path)),
      [],
      `${profileName} write permissions must include every media directory`,
    );
  }
});

Deno.test("manual CLI runs allow dynamic Telegram and LLM network endpoints", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json")) as {
    permissions: Record<string, PermissionProfile>;
  };

  assertEquals(denoConfig.permissions.cli?.net, true);
  assertEquals(denoConfig.permissions.cli?.sys, undefined);
});

Deno.test("production command grants read and write access to every media directory", async () => {
  const command = await Deno.readTextFile(
    "./scripts/production-start.template.sh",
  );

  for (const permission of ["read", "write"] as const) {
    const match = command.match(new RegExp(`--allow-${permission}=([^\\s]+)`));
    const paths = match?.[1].split(",");
    assertEquals(
      MEDIA_PATHS.filter((path) => !paths?.includes(path)),
      [],
      `production --allow-${permission} must include every media directory`,
    );
  }
});
