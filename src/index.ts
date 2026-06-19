console.warn(
  "Deprecated: src/index.ts is no longer the primary entry point.\n" +
    "Use src/cli/run-once.ts for the one-shot pipeline or src/server/main.ts for the API server.\n" +
    "See deno.json tasks: 'deno task dev:cli' and 'deno task dev:api'.",
);
