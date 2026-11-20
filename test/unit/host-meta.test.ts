import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  getNimbleBrainHostMeta,
  hostBlockViolation,
  normalizeHostMeta,
} from "../../src/connectors/catalog/host-meta.ts";
import { serverDetailToCatalogEntry } from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import { parseHookDeclarations } from "../../src/hooks/declaration.ts";
import { log } from "../../src/observability/log.ts";
import { parseAdminToolsDeclaration } from "../../src/permissions/admin-tools.ts";

/**
 * The host block's read boundary: either spelling in, camelCase out, every
 * two-copy rule failing closed and keyed on presence. Each renamed field runs
 * the same matrix: snake only, camel only, both equal, both differing,
 * malformed.
 */

let entrySeq = 0;
/** A fresh entry name per call, so a once-per-process warning is not swallowed by an earlier test. */
const entry = () => `ai.acme/entry-${++entrySeq}`;

const normalize = (raw: Record<string, unknown>) => normalizeHostMeta(raw, entry());

let warn: Mock<typeof log.warn>;
beforeEach(() => {
  warn = spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("hostVersion", () => {
  test("snake only is read as hostVersion", () => {
    expect(normalize({ host_version: "1.0" })?.hostVersion).toBe("1.0");
    expect(hostBlockViolation({ host_version: "1.0" })).toBeNull();
  });

  test("camel only", () => {
    expect(normalize({ hostVersion: "1.2" })?.hostVersion).toBe("1.2");
    expect(hostBlockViolation({ hostVersion: "1.2" })).toBeNull();
  });

  test("both equal", () => {
    expect(hostBlockViolation({ hostVersion: "1.0", host_version: "1.0" })).toBeNull();
  });

  test("both differing drops the entry, even when both are major 1", () => {
    expect(hostBlockViolation({ hostVersion: "1.0", host_version: "1.1" })).toContain("disagree");
    expect(hostBlockViolation({ hostVersion: "1.0", host_version: null })).toContain("disagree");
  });

  test("malformed, or another major, drops the entry", () => {
    for (const v of [null, 1, "2.0", "", "v1"]) {
      expect(hostBlockViolation({ hostVersion: v })).toContain("major 1");
      expect(hostBlockViolation({ host_version: v })).toContain("major 1");
    }
    expect(hostBlockViolation({ placements: [] })).toContain("major 1");
    expect(hostBlockViolation("1.0")).toContain("not an object");
    expect(hostBlockViolation(undefined)).toBeNull();
    expect(hostBlockViolation(null)).toBeNull();
  });
});

describe("adminTools", () => {
  const parse = (raw: Record<string, unknown>) =>
    parseAdminToolsDeclaration(normalize({ hostVersion: "1.0", ...raw }), "ai.acme/crm");

  test("snake only", () => {
    expect(parse({ admin_tools: ["configure"] })).toEqual({ kind: "names", names: ["configure"] });
  });

  test("camel only", () => {
    expect(parse({ adminTools: ["configure"] })).toEqual({ kind: "names", names: ["configure"] });
  });

  test("both equal", () => {
    expect(parse({ adminTools: ["configure"], admin_tools: ["configure"] })).toEqual({
      kind: "names",
      names: ["configure"],
    });
  });

  test("both differing gates the union", () => {
    expect(parse({ adminTools: ["configure"], admin_tools: ["rotate", "configure"] })).toEqual({
      kind: "names",
      names: ["configure", "rotate"],
    });
    // An empty copy declares nothing, so it narrows nothing away.
    expect(parse({ adminTools: [], admin_tools: ["rotate"] })).toEqual({
      kind: "names",
      names: ["rotate"],
    });
  });

  test("a malformed copy in either spelling gates every tool", () => {
    for (const bad of [null, "configure", false, 0, {}, [""], ["has space"]]) {
      expect(parse({ admin_tools: bad })?.kind).toBe("all");
      expect(parse({ adminTools: bad })?.kind).toBe("all");
      expect(parse({ adminTools: ["configure"], admin_tools: bad })?.kind).toBe("all");
      expect(parse({ adminTools: bad, admin_tools: ["configure"] })?.kind).toBe("all");
    }
  });

  test("a copy over the cap gates every tool, though the other is well-formed", () => {
    const over = Array.from({ length: 65 }, (_, i) => `tool_${i % 30}`);
    expect(parse({ adminTools: ["configure"], admin_tools: over })?.kind).toBe("all");
  });

  test("a present key is a declaration whatever its value", () => {
    expect(parse({ adminTools: undefined })?.kind).toBe("all");
  });
});

describe("the gated admin set holds every name from either spelling", () => {
  // A seeded generator, so a failure replays.
  let seed = 0x5eed;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const pool = ["configure", "rotate", "export", "purge", "invite", "set_webhook_url"];
  const pick = () => pool.filter(() => next() % 2 === 0);

  test("over random pairs of copies", () => {
    for (let i = 0; i < 500; i++) {
      const camel = next() % 4 === 0 ? undefined : pick();
      const snake = next() % 4 === 0 ? undefined : pick();
      const raw: Record<string, unknown> = { hostVersion: "1.0" };
      if (camel) raw.adminTools = camel;
      if (snake) raw.admin_tools = snake;
      const decl = parseAdminToolsDeclaration(normalize(raw), "ai.acme/crm");
      for (const name of [...(camel ?? []), ...(snake ?? [])]) {
        const gated = decl?.kind === "all" || (decl?.kind === "names" && decl.names.includes(name));
        expect(gated).toBe(true);
      }
    }
  });
});

describe("recordArguments", () => {
  const granted = (raw: Record<string, unknown>) =>
    normalize({ hostVersion: "1.0", ...raw })?.recordArguments;

  test("snake only", () => {
    expect(granted({ record_arguments: true })).toBe(true);
  });

  test("camel only", () => {
    expect(granted({ recordArguments: true })).toBe(true);
  });

  test("both equal", () => {
    expect(granted({ recordArguments: true, record_arguments: true })).toBe(true);
  });

  test("both differing grants nothing", () => {
    expect(granted({ recordArguments: true, record_arguments: false })).toBe(false);
    expect(granted({ recordArguments: false, record_arguments: true })).toBe(false);
  });

  test("a malformed copy grants nothing", () => {
    for (const bad of ["true", 1, null, undefined, {}]) {
      expect(granted({ recordArguments: bad })).toBe(false);
      expect(granted({ recordArguments: true, record_arguments: bad })).toBe(false);
    }
  });

  test("absent is not declared", () => {
    expect(granted({})).toBeUndefined();
  });
});

describe("a hook's registerTool and headerRenames", () => {
  const BASE = { vendor: "acme", route: "/ingest/acme" };
  const hooks = (hook: Record<string, unknown>) =>
    parseHookDeclarations(normalize({ hostVersion: "1.0", hooks: [hook] }));

  test("snake only", () => {
    expect(
      hooks({ ...BASE, register_tool: "set_url", header_renames: { Authorization: "x-sig" } }),
    ).toEqual([{ ...BASE, registerTool: "set_url", headerRenames: { authorization: "x-sig" } }]);
  });

  test("camel only", () => {
    expect(
      hooks({ ...BASE, registerTool: "set_url", headerRenames: { Authorization: "x-sig" } }),
    ).toEqual([{ ...BASE, registerTool: "set_url", headerRenames: { authorization: "x-sig" } }]);
  });

  test("both equal", () => {
    expect(
      hooks({
        ...BASE,
        registerTool: "set_url",
        register_tool: "set_url",
        headerRenames: { a: "x-a", b: "x-b" },
        header_renames: { b: "x-b", a: "x-a" },
      }),
    ).toEqual([{ ...BASE, registerTool: "set_url", headerRenames: { a: "x-a", b: "x-b" } }]);
  });

  test("both differing drops that hook, keeps the others, and warns", () => {
    const name = entry();
    const meta = normalizeHostMeta(
      {
        hostVersion: "1.0",
        hooks: [
          { ...BASE, registerTool: "set_url", register_tool: "other" },
          { vendor: "beta", route: "/in/beta", registerTool: "set_url" },
        ],
      },
      name,
    );
    expect(parseHookDeclarations(meta).map((h) => h.vendor)).toEqual(["beta"]);
    expect(
      hooks({
        ...BASE,
        registerTool: "set_url",
        headerRenames: { a: "x-a" },
        header_renames: { a: "x-b" },
      }),
    ).toEqual([]);
    expect(hooks({ ...BASE, registerTool: "set_url", register_tool: null })).toEqual([]);
    expect(warn.mock.calls.some(([m]) => m.includes(name) && m.includes("dropped"))).toBe(true);
  });

  test("malformed in either spelling drops the hook", () => {
    expect(hooks({ ...BASE, register_tool: "" })).toEqual([]);
    expect(hooks({ ...BASE, registerTool: 7 })).toEqual([]);
    expect(hooks({ ...BASE, register_tool: "set_url", header_renames: "nope" })).toEqual([
      { ...BASE, registerTool: "set_url" },
    ]);
  });
});

describe("the normalized block", () => {
  test("carries only camelCase keys and no retired field", () => {
    const meta = normalize({
      host_version: "1.0",
      name: "Hello",
      icon: "hand",
      category: "ops",
      primaryView: {},
      briefing: {},
      admin_tools: ["configure"],
      record_arguments: true,
      hooks: [{ vendor: "acme", route: "/in", register_tool: "set" }],
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
      expect(normalizeHostMeta(raw, entry())).toBeUndefined();
    }
  });
});

describe("the deprecation warning", () => {
  function detail(name: string, host: Record<string, unknown>): ServerDetail {
    return {
      name,
      description: "Acme",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      _meta: { "ai.nimblebrain/host": host },
    };
  }

  test("names every snake key, once per entry per process", () => {
    const name = entry();
    const d = detail(name, {
      host_version: "1.0",
      admin_tools: ["configure"],
      hooks: [{ vendor: "acme", route: "/in", register_tool: "set" }],
    });
    getNimbleBrainHostMeta(d);
    serverDetailToCatalogEntry(d);
    serverDetailToCatalogEntry(d);
    const lines = warn.mock.calls.map(([m]) => m).filter((m) => m.includes(name));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deprecated host key");
    for (const key of ["host_version", "admin_tools", "hooks[].register_tool"]) {
      expect(lines[0]).toContain(key);
    }
  });

  test("says nothing for a camelCase block", () => {
    const name = entry();
    serverDetailToCatalogEntry(detail(name, { hostVersion: "1.0", adminTools: ["configure"] }));
    expect(warn.mock.calls.some(([m]) => m.includes(name))).toBe(false);
  });
});
