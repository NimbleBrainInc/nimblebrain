import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import {
  DEPRECATED_HOOK_KEYS,
  DEPRECATED_HOST_KEYS,
} from "../../src/connectors/catalog/host-meta.ts";
import schema from "../../src/connectors/catalog/schemas/host-manifest.schema.json";
import type { HostManifestMeta, PlacementDeclaration } from "../../src/connectors/runtime/types.ts";
import type { HookDeclaration } from "../../src/hooks/types.ts";

/**
 * The published host schema and the types the runtime reads it into describe
 * one contract. Each key list below is checked against its type by the
 * compiler (`satisfies`: no key missing, none extra), and against the schema
 * here, so a field added to one and not the other fails the build.
 */

const HOST_KEYS = {
  hostVersion: true,
  placements: true,
  hooks: true,
  notifications: true,
  adminTools: true,
  recordArguments: true,
} as const satisfies Record<keyof HostManifestMeta, true>;

const HOOK_KEYS = {
  vendor: true,
  route: true,
  registerTool: true,
  description: true,
  headerRenames: true,
} as const satisfies Record<keyof HookDeclaration, true>;

const PLACEMENT_KEYS = {
  slot: true,
  resourceUri: true,
  priority: true,
  label: true,
  icon: true,
  route: true,
} as const satisfies Record<keyof PlacementDeclaration, true>;

const sorted = (keys: Iterable<string>) => [...keys].sort();

/** The schema's properties, split into the current spelling and the deprecated one. */
function split(properties: object, deprecated: Readonly<Record<string, string>>) {
  const all = Object.keys(properties);
  return {
    camel: all.filter((k) => !Object.hasOwn(deprecated, k)),
    snake: all.filter((k) => Object.hasOwn(deprecated, k)),
  };
}

describe("host-manifest.schema.json and the runtime's types", () => {
  test("the block's camelCase properties are HostManifestMeta's keys", () => {
    const { camel } = split(schema.properties, DEPRECATED_HOST_KEYS);
    expect(sorted(camel)).toEqual(sorted(Object.keys(HOST_KEYS)));
  });

  test("every deprecated block property is one the runtime reads, as a key of HostManifestMeta", () => {
    const { snake } = split(schema.properties, DEPRECATED_HOST_KEYS);
    expect(sorted(snake)).toEqual(sorted(Object.keys(DEPRECATED_HOST_KEYS)));
    for (const camel of Object.values(DEPRECATED_HOST_KEYS)) {
      expect(Object.keys(HOST_KEYS)).toContain(camel);
    }
  });

  test("a hook's camelCase properties are HookDeclaration's keys", () => {
    const props = schema.$defs.HookDeclaration.properties;
    const { camel, snake } = split(props, DEPRECATED_HOOK_KEYS);
    expect(sorted(camel)).toEqual(sorted(Object.keys(HOOK_KEYS)));
    expect(sorted(snake)).toEqual(sorted(Object.keys(DEPRECATED_HOOK_KEYS)));
    for (const key of Object.values(DEPRECATED_HOOK_KEYS)) {
      expect(Object.keys(HOOK_KEYS)).toContain(key);
    }
  });

  test("a placement's properties are PlacementDeclaration's keys", () => {
    const props = schema.$defs.PlacementDeclaration.properties;
    expect(sorted(Object.keys(props))).toEqual(sorted(Object.keys(PLACEMENT_KEYS)));
  });

  test("each deprecated property says what it is deprecated for", () => {
    const descriptionOf = (props: object, key: string): unknown =>
      Object.entries(props).find(([k]) => k === key)?.[1]?.description;
    for (const [snake, camel] of Object.entries(DEPRECATED_HOST_KEYS)) {
      expect(descriptionOf(schema.properties, snake)).toStartWith(
        `Deprecated spelling of ${camel}`,
      );
    }
    for (const [snake, camel] of Object.entries(DEPRECATED_HOOK_KEYS)) {
      expect(descriptionOf(schema.$defs.HookDeclaration.properties, snake)).toStartWith(
        `Deprecated spelling of ${camel}`,
      );
    }
  });
});

describe("the published host schema accepts either spelling", () => {
  const validate = new Ajv({ strict: false }).compile(schema);
  const hook = { vendor: "acme", route: "/ingest/acme" };

  test("a block needs hostVersion in one spelling", () => {
    expect(validate({ hostVersion: "1.0" })).toBe(true);
    expect(validate({ host_version: "1.0" })).toBe(true);
    expect(validate({ placements: [] })).toBe(false);
  });

  test("a hook needs registerTool in one spelling", () => {
    expect(validate({ hostVersion: "1.0", hooks: [{ ...hook, registerTool: "set" }] })).toBe(true);
    expect(validate({ hostVersion: "1.0", hooks: [{ ...hook, register_tool: "set" }] })).toBe(true);
    expect(validate({ hostVersion: "1.0", hooks: [hook] })).toBe(false);
  });

  test("a placement has no size", () => {
    const placement = { slot: "main", resourceUri: "ui://a/b" };
    expect(validate({ hostVersion: "1.0", placements: [placement] })).toBe(true);
    expect(validate({ hostVersion: "1.0", placements: [{ ...placement, size: "full" }] })).toBe(
      false,
    );
  });

  test("the deprecated adminTools spelling is held to the same shape", () => {
    expect(validate({ hostVersion: "1.0", admin_tools: ["configure"] })).toBe(true);
    expect(validate({ hostVersion: "1.0", admin_tools: "configure" })).toBe(false);
  });
});
