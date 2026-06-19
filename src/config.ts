export interface Config {
  databaseUrl: string;
  port: number;
}

export function getConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: overrides.databaseUrl ?? Deno.env.get("DATABASE_URL") ?? "",
    port: overrides.port ?? (Number(Deno.env.get("PORT")) || 3000),
  };
}
