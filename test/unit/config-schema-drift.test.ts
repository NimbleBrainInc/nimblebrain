import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveFeatures } from "../../src/config/features.ts";
import {
  COMPOSIO_PROVIDER_CONFIG_KEYS,
  GATEWAY_CONFIG_KEYS,
  SMITHERY_PROVIDER_CONFIG_KEYS,
  CONNECTORS_CONFIG_KEYS,
  MANAGED_PROVIDER_KEYS,
} from "../../src/connectors/providers/config.ts";
import { MODEL_SLOTS } from "../../src/model/slots.ts";
import { NOTIFICATIONS_POLL_CONFIG_KEYS } from "../../src/notifications/poll-config.ts";

/**
 * Drift guard: the published config schema must stay in lockstep with the
 * runtime's actual config surface.
 *
 * `src/config/nimblebrain-config.schema.json` is the canonical source for
 * nimblebrain.json validation (the runtime compiles it with AJV at startup) and
 * is published to schemas.nimblebrain.ai by `.github/workflows/schema-deploy.yml`.
 * Every object guarded here uses `additionalProperties: false`, and neither
 * direction of drift fails a boot. A key in the runtime type but missing from
 * the schema still reaches `RuntimeConfig` and still works — Ajv is compiled
 * without `removeAdditional`, `loadConfig` sorts unknown keys into warnings and
 * throws only on structural errors, and the guarded parent is assigned whole.
 * What it costs is a boot line calling the key "(ignored)" when it was not, and
 * a published schema that flags a legitimate key in editors. A key in the
 * schema with no backing code is the mirror image: a dead knob that reads as
 * configurable. This test turns either drift into a build failure in the repo
 * where the key is authored.
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
    models: SchemaObject;
    notifications: SchemaObject & {
      properties: { poll: SchemaObject };
    };
    connectors: SchemaObject & {
      properties: {
        providers: SchemaObject & {
          properties: { composio: SchemaObject };
        };
        // Gateway names are operator-chosen, so the map itself is open and the
        // per-gateway object under `additionalProperties` is what is closed.
        gateways: { additionalProperties: SchemaObject };
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

describe("config schema ↔ model slots", () => {
  // `MODEL_SLOTS` is the runtime's list of role names, and `scripts/dev-worktree.ts`
  // seeds a `models` block against the schema's copy of it. Without this, a slot
  // added to the runtime leaves the schema behind and the seed cannot use it.
  expectLockstep("models", schema.properties.models, [...MODEL_SLOTS]);
});

describe("config schema ↔ managed-connector provider config", () => {
  // The key lists come from `Record<keyof Required<T>, true>` maps in
  // `providers/config.ts`, so a field added to one of those interfaces is a
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
    "connectors.providers.smithery",
    connectors.properties.providers.properties.smithery,
    SMITHERY_PROVIDER_CONFIG_KEYS,
  );
  // Not the `gateways` map — its keys are gateway names, so it is deliberately
  // open. The closed object is one gateway's own block.
  expectLockstep(
    "connectors.gateways.<name>",
    connectors.properties.gateways.additionalProperties,
    GATEWAY_CONFIG_KEYS,
  );
});

describe("config schema ↔ notification poll config", () => {
  // The key list is `resolvePollConfig()`'s own output, so a fifth knob added
  // to the runtime is a failure here until the published schema declares it —
  // and a knob declared here with nothing resolving it is a dead one an editor
  // would still offer.
  expectLockstep(
    "notifications.poll",
    schema.properties.notifications.properties.poll,
    NOTIFICATIONS_POLL_CONFIG_KEYS,
  );
  // The parent carries exactly one member today; declaring it keeps a future
  // `notifications.<something>` from landing in the schema alone.
  expectLockstep("notifications", schema.properties.notifications, ["poll"]);
});
