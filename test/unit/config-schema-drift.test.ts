import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveFeatures } from "../../src/config/features.ts";
import {
  COMPOSIO_MONITOR_CONFIG_KEYS,
  COMPOSIO_PROVIDER_CONFIG_KEYS,
  CONNECTORS_CONFIG_KEYS,
  MANAGED_PROVIDER_KEYS,
} from "../../src/connectors/providers/config.ts";

/**
 * Drift guard: the published config schema must stay in lockstep with the
 * runtime's actual config surface.
 *
 * `src/config/nimblebrain-config.schema.json` is the canonical source for
 * nimblebrain.json validation (the runtime compiles it with AJV at startup) and
 * is published to schemas.nimblebrain.ai by `.github/workflows/schema-deploy.yml`.
 * Every object guarded here uses `additionalProperties: false`, so a key added to
 * the runtime type but missing from the schema is rejected as an unknown key at
 * startup; a key in the schema with no backing code is a dead knob. Both are
 * silent until someone hits them — this test turns the drift into a build
 * failure in the repo where the key is authored.
 */
interface SchemaObject {
  properties: Record<string, unknown>;
  additionalProperties: boolean;
}

const schema = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../src/config/nimblebrain-config.schema.json"), "utf8"),
) as {
  properties: {
    features: SchemaObject;
    connectors: SchemaObject & {
      properties: {
        providers: SchemaObject & {
          properties: { composio: SchemaObject & { properties: { monitor: SchemaObject } } };
        };
      };
    };
  };
};

/** Assert a schema object declares exactly `runtimeKeys` and refuses anything else. */
function expectLockstep(label: string, node: SchemaObject, runtimeKeys: string[]): void {
  const schemaKeys = Object.keys(node.properties).sort();
  const sorted = [...runtimeKeys].sort();

  test(`${label}: every runtime key is declared in the schema`, () => {
    expect(sorted.filter((k) => !schemaKeys.includes(k))).toEqual([]);
  });

  test(`${label}: every schema property has a backing runtime key`, () => {
    expect(schemaKeys.filter((k) => !sorted.includes(k))).toEqual([]);
  });

  test(`${label}: the object refuses unknown keys`, () => {
    // The drift guard only holds if unknown keys are constrained; if this flips
    // to true, the two assertions above stop meaning anything.
    expect(node.additionalProperties).toBe(false);
  });
}

describe("config schema ↔ feature flags", () => {
  // resolveFeatures() with no argument returns the complete default set, so its
  // keys are the authoritative list of every feature flag the runtime knows.
  expectLockstep("features", schema.properties.features, Object.keys(resolveFeatures()));
});

describe("config schema ↔ managed-connector provider config", () => {
  // The key lists come from `Record<keyof Required<T>, true>` maps in
  // `provider-config.ts`, so a field added to one of those interfaces is a
  // compile error until it is listed, and a failure here until it is declared
  // in the schema.
  const connectors = schema.properties.connectors;
  expectLockstep("connectors", connectors, CONNECTORS_CONFIG_KEYS);
  expectLockstep("connectors.providers", connectors.properties.providers, MANAGED_PROVIDER_KEYS);
  expectLockstep(
    "connectors.providers.composio",
    connectors.properties.providers.properties.composio,
    COMPOSIO_PROVIDER_CONFIG_KEYS,
  );
  expectLockstep(
    "connectors.providers.composio.monitor",
    connectors.properties.providers.properties.composio.properties.monitor,
    COMPOSIO_MONITOR_CONFIG_KEYS,
  );
});
