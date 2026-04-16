import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const SCHEMA_URL = "https://schemas.nimblebrain.ai/v1/nimblebrain-config.schema.json";
const OUTPUT = resolve(import.meta.dir, "../src/config/nimblebrain-config.schema.json");

if (existsSync(OUTPUT) && !process.env.FORCE_SCHEMA_FETCH) {
  console.log("Config schema already cached, skipping fetch (set FORCE_SCHEMA_FETCH=1 to refresh)");
  process.exit(0);
}

console.log(`Fetching config schema from ${SCHEMA_URL}...`);
const res = await fetch(SCHEMA_URL);
if (!res.ok) {
  console.error(`Failed to fetch schema: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const schema = await res.text();

try {
  JSON.parse(schema);
} catch {
  console.error("Fetched content is not valid JSON");
  process.exit(1);
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, schema);
console.log(`Config schema written to ${OUTPUT}`);
