const EXAMPLE_PATH = ".env.example";
const PRODUCTION_PATH = ".env.production.local";

function assignmentKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

const [example, production] = await Promise.all([
  Bun.file(EXAMPLE_PATH).text(),
  Bun.file(PRODUCTION_PATH).text(),
]);

const productionKeys = assignmentKeys(production);
const missing = [...assignmentKeys(example)]
  .filter((key) => !productionKeys.has(key))
  .sort();

if (missing.length > 0) {
  console.error(
    `Missing required keys in ${PRODUCTION_PATH}: ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log(`${PRODUCTION_PATH} contains every key from ${EXAMPLE_PATH}.`);
