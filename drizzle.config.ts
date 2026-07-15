const runtime = globalThis as typeof globalThis & {
  Deno?: { env: { get(name: string): string | undefined } };
  process?: { env: Record<string, string | undefined> };
};

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: runtime.Deno?.env.get("DATABASE_URL") ?? runtime.process?.env.DATABASE_URL ?? "",
  },
};
