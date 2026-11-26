import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import schema from "../../schemas/host/v1/host.schema.json";
import { RETIRED_HOOK_KEYS, RETIRED_HOST_KEYS } from "../../src/connectors/catalog/host-meta.ts";
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

describe("schemas/host/v1/host.schema.json and the runtime's types", () => {
  test("the block's properties are HostManifestMeta's keys", () => {
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(Object.keys(HOST_KEYS)));
  });

  test("a hook's properties are HookDeclaration's keys", () => {
    const props = schema.$defs.HookDeclaration.properties;
    expect(sorted(Object.keys(props))).toEqual(sorted(Object.keys(HOOK_KEYS)));
  });

  test("a placement's properties are PlacementDeclaration's keys", () => {
    const props = schema.$defs.PlacementDeclaration.properties;
    expect(sorted(Object.keys(props))).toEqual(sorted(Object.keys(PLACEMENT_KEYS)));
  });
});

describe("the published host schema is camelCase only", () => {
  const validate = new Ajv({ strict: false }).compile(schema);
  const hook = { vendor: "acme", route: "/ingest/acme" };

  test("a block needs hostVersion", () => {
    expect(validate({ hostVersion: "1.0" })).toBe(true);
    expect(validate({ host_version: "1.0" })).toBe(false);
    expect(validate({ placements: [] })).toBe(false);
  });

  test("a hook needs registerTool", () => {
    expect(validate({ hostVersion: "1.0", hooks: [{ ...hook, registerTool: "set" }] })).toBe(true);
    expect(validate({ hostVersion: "1.0", hooks: [{ ...hook, register_tool: "set" }] })).toBe(
      false,
    );
    expect(validate({ hostVersion: "1.0", hooks: [hook] })).toBe(false);
  });

  test("every retired snake_case key is refused, beside a valid camel block", () => {
    for (const key of RETIRED_HOST_KEYS) {
      expect(validate({ hostVersion: "1.0", [key]: true })).toBe(false);
    }
    for (const key of RETIRED_HOOK_KEYS) {
      expect(
        validate({ hostVersion: "1.0", hooks: [{ ...hook, registerTool: "set", [key]: {} }] }),
      ).toBe(false);
    }
  });

  test("a placement has no size", () => {
    const placement = { slot: "main", resourceUri: "ui://a/b" };
    expect(validate({ hostVersion: "1.0", placements: [placement] })).toBe(true);
    expect(validate({ hostVersion: "1.0", placements: [{ ...placement, size: "full" }] })).toBe(
      false,
    );
  });
});
