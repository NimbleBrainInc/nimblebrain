import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  hostBlockViolation,
  normalizeHostMeta,
  retiredHostKeys,
} from "../../src/connectors/catalog/host-meta.ts";
import { serverDetailToCatalogEntry } from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import { parseHookDeclarations } from "../../src/hooks/declaration.ts";
import { log } from "../../src/observability/log.ts";
import { parseAdminToolsDeclaration } from "../../src/permissions/admin-tools.ts";

/**
 * The host block's read boundary: camelCase is the only spelling read. A
 * snake_case key is read as absent, except `admin_tools`, whose presence gates
 * every tool on the server.
 */

let connectorSeq = 0;
/** A fresh connector name per call, so a once-per-process warning is not swallowed by an earlier test. */
const connector = () => `ai.acme/entry-${++connectorSeq}`;

let warn: Mock<typeof log.warn>;
beforeEach(() => {
  warn = spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("hostVersion", () => {
  test("camelCase is read", () => {
    expect(normalizeHostMeta({ hostVersion: "1.2" })?.hostVersion).toBe("1.2");
    expect(hostBlockViolation({ hostVersion: "1.2" })).toBeNull();
  });

  test("host_version alone is no version, so the entry is dropped", () => {
    expect(normalizeHostMeta({ host_version: "1.0" })?.hostVersion).toBeUndefined();
    expect(hostBlockViolation({ host_version: "1.0" })).toContain("major 1");
  });

  test("host_version beside a valid hostVersion changes nothing", () => {
    expect(hostBlockViolation({ hostVersion: "1.0", host_version: "2.0" })).toBeNull();
  });

  test("malformed, or another major, drops the entry", () => {
    for (const v of [null, 1, "2.0", "", "v1"]) {
      expect(hostBlockViolation({ hostVersion: v })).toContain("major 1");
    }
    expect(hostBlockViolation({ placements: [] })).toContain("major 1");
    expect(hostBlockViolation("1.0")).toContain("not an object");
    expect(hostBlockViolation(undefined)).toBeNull();
    expect(hostBlockViolation(null)).toBeNull();
  });
});

describe("adminTools", () => {
  const parse = (raw: Record<string, unknown>, name = connector()) =>
    parseAdminToolsDeclaration(normalizeHostMeta({ hostVersion: "1.0", ...raw }), name);

  test("a well-formed list gates those names", () => {
    expect(parse({ adminTools: ["configure"] })).toEqual({ kind: "names", names: ["configure"] });
    expect(parse({ adminTools: ["configure", "configure"] })).toEqual({
      kind: "names",
      names: ["configure"],
    });
  });

  test("an empty list, or no key, declares nothing", () => {
    expect(parse({ adminTools: [] })).toBeUndefined();
    expect(parse({})).toBeUndefined();
  });

  test("a malformed value gates every tool", () => {
    for (const bad of [null, "configure", false, 0, {}, [""], ["has space"]]) {
      expect(parse({ adminTools: bad })?.kind).toBe("all");
    }
    const over = Array.from({ length: 65 }, (_, i) => `tool_${i}`);
    expect(parse({ adminTools: over })?.kind).toBe("all");
  });

  test("a present key is a declaration whatever its value", () => {
    expect(parse({ adminTools: undefined })?.kind).toBe("all");
  });
});

describe("the admin_tools tombstone", () => {
  const parse = (raw: Record<string, unknown>, name = connector()) =>
    parseAdminToolsDeclaration(normalizeHostMeta({ hostVersion: "1.0", ...raw }), name);

  test("admin_tools alone gates every tool", () => {
    const decl = parse({ admin_tools: ["configure"] });
    expect(decl?.kind).toBe("all");
    expect(decl?.kind === "all" ? decl.reason : "").toContain("admin_tools");
  });

  test("admin_tools beside a valid adminTools gates every tool", () => {
    expect(parse({ adminTools: ["configure"], admin_tools: ["configure"] })?.kind).toBe("all");
    expect(parse({ adminTools: ["configure"], admin_tools: ["rotate"] })?.kind).toBe("all");
    expect(parse({ adminTools: [], admin_tools: [] })?.kind).toBe("all");
  });

  test("a malformed admin_tools gates every tool, keyed on presence not value", () => {
    for (const bad of [null, undefined, false, 0, "", "configure", {}, [], [""], ["has space"]]) {
      expect(parse({ admin_tools: bad })?.kind).toBe("all");
      expect(parse({ adminTools: ["configure"], admin_tools: bad })?.kind).toBe("all");
    }
  });

  test("warns once per connector, naming admin_tools and adminTools as the spelling", () => {
    const name = connector();
    parse({ admin_tools: ["configure"] }, name);
    parse({ admin_tools: ["configure"] }, name);
    const lines = warn.mock.calls.map(([m]) => m).filter((m) => m.includes(name));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("admin_tools");
    expect(lines[0]).toContain("adminTools is the spelling");
    expect(lines[0]).toContain("every tool on it is admin-only");
  });

  test("the projected catalog entry carries the gate", () => {
    const detail: ServerDetail = {
      name: connector(),
      description: "Acme",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      _meta: { "ai.nimblebrain/host": { hostVersion: "1.0", admin_tools: ["configure"] } },
    };
    expect(serverDetailToCatalogEntry(detail)?.adminTools?.kind).toBe("all");
  });
});

describe("recordArguments", () => {
  const granted = (raw: Record<string, unknown>) =>
    normalizeHostMeta({ hostVersion: "1.0", ...raw })?.recordArguments;

  test("true grants", () => {
    expect(granted({ recordArguments: true })).toBe(true);
  });

  test("a malformed value grants nothing", () => {
    for (const bad of ["true", 1, null, undefined, {}, false]) {
      expect(granted({ recordArguments: bad })).toBe(false);
    }
  });

  test("absent is not declared", () => {
    expect(granted({})).toBeUndefined();
  });

  test("record_arguments is not read", () => {
    expect(granted({ record_arguments: true })).toBeUndefined();
    expect(granted({ recordArguments: false, record_arguments: true })).toBe(false);
  });
});

describe("a hook's registerTool and headerRenames", () => {
  const BASE = { vendor: "acme", route: "/ingest/acme" };
  const hooks = (hook: Record<string, unknown>) =>
    parseHookDeclarations(normalizeHostMeta({ hostVersion: "1.0", hooks: [hook] }));

  test("camelCase is read", () => {
    expect(
      hooks({ ...BASE, registerTool: "set_url", headerRenames: { Authorization: "x-sig" } }),
    ).toEqual([{ ...BASE, registerTool: "set_url", headerRenames: { authorization: "x-sig" } }]);
  });

  test("register_tool alone is no registerTool, so the hook is dropped", () => {
    expect(hooks({ ...BASE, register_tool: "set_url" })).toEqual([]);
  });

  test("header_renames is not read", () => {
    expect(
      hooks({ ...BASE, registerTool: "set_url", header_renames: { Authorization: "x-sig" } }),
    ).toEqual([{ ...BASE, registerTool: "set_url" }]);
  });

  test("a malformed registerTool drops the hook", () => {
    expect(hooks({ ...BASE, registerTool: "" })).toEqual([]);
    expect(hooks({ ...BASE, registerTool: 7 })).toEqual([]);
  });
});

describe("the normalized block", () => {
  test("carries only the camelCase fields it knows", () => {
    const meta = normalizeHostMeta({
      hostVersion: "1.0",
      name: "Hello",
      icon: "hand",
      category: "ops",
      primaryView: {},
      briefing: {},
      adminTools: ["configure"],
      recordArguments: true,
      hooks: [{ vendor: "acme", route: "/in", registerTool: "set" }],
      placements: [],
      notifications: { resource: "acme://n" },
    });
    expect(meta).toEqual({
      hostVersion: "1.0",
      adminTools: ["configure"],
      recordArguments: true,
      hooks: [{ vendor: "acme", route: "/in", registerTool: "set" }],
      placements: [],
      notifications: { resource: "acme://n" },
    });
  });

  test("is undefined for no block or one that is not an object", () => {
    for (const raw of [undefined, null, "1.0", 7, []]) {
      expect(normalizeHostMeta(raw)).toBeUndefined();
    }
  });

  test("logs nothing for a camelCase block, nor for an ignored snake key", () => {
    normalizeHostMeta({ hostVersion: "1.0", adminTools: ["configure"], record_arguments: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("retiredHostKeys", () => {
  test("names each snake_case key a block carries", () => {
    expect(
      retiredHostKeys({
        host_version: "1.0",
        admin_tools: [],
        record_arguments: true,
        hooks: [{ vendor: "acme", route: "/in", register_tool: "set", header_renames: {} }],
      }),
    ).toEqual([
      "host_version",
      "admin_tools",
      "record_arguments",
      "hooks[].register_tool",
      "hooks[].header_renames",
    ]);
  });

  test("is empty for a camelCase block, or none", () => {
    expect(retiredHostKeys({ hostVersion: "1.0", adminTools: ["configure"] })).toEqual([]);
    expect(retiredHostKeys(undefined)).toEqual([]);
  });
});
