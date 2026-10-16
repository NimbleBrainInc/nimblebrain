import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRegistry,
  type ProvidersConfig,
  providerModelAllowlists,
} from "../../src/model/registry.ts";

/**
 * Every field the config schema declares under `providers.<id>` is read by the
 * runtime.
 *
 * A provider's config has two readers: `buildRegistry` (credentials and
 * endpoint) and `providerModelAllowlists` (the model allowlist). This test
 * hands both a config carrying every declared field, records which fields they
 * read, and fails on any field neither touches. A field in the schema and the
 * TypeScript type alike, read by nothing, is a knob that reads as configurable
 * and does nothing; the schema-to-type drift guard cannot see it, because the
 * two agree.
 */

interface ProviderSchema {
  properties: Record<string, unknown>;
}

const schema = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../src/config/nimblebrain-config.schema.json"), "utf8"),
) as { properties: { providers: { properties: Record<string, ProviderSchema> } } };

const providerSchemas = schema.properties.providers.properties;

/**
 * A value of the right shape for the fields the readers parse. Any other field
 * gets a placeholder: the test asks only whether it is read.
 */
const SAMPLE_VALUES: Record<string, unknown> = {
  apiKey: "test-key",
  baseURL: "https://provider.example.com/v1",
  organization: "test-org",
  models: ["test-model"],
};

/** A provider config carrying every declared field, recording each field read. */
function recordingConfig(fields: string[], reads: Set<string>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field] = SAMPLE_VALUES[field] ?? "placeholder";
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

describe("config schema ↔ provider config readers", () => {
  for (const [id, providerSchema] of Object.entries(providerSchemas)) {
    test(`providers.${id}: every declared field is read`, () => {
      const fields = Object.keys(providerSchema.properties);
      const reads = new Set<string>();
      // biome-ignore lint/plugin/double-cast: the schema's provider ids are the type's keys; the test builds the config from the schema rather than the type
      const config = {
        providers: { [id]: recordingConfig(fields, reads) },
      } as unknown as ProvidersConfig;

      buildRegistry(config);
      providerModelAllowlists(config);

      expect(fields.filter((f) => !reads.has(f))).toEqual([]);
    });
  }
});
