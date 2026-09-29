import { describe, expect, test } from "bun:test";
import { serverDetailToCatalogEntry } from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import type { AdminToolsDeclaration } from "../../src/connectors/catalog/types.ts";
import type { HostManifestMeta } from "../../src/connectors/runtime/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { OrgRole } from "../../src/identity/types.ts";
import {
  ADMIT_ALL,
  adminToolDenial,
  adminToolsContractWarnings,
  filterAdmittedTools,
  isAdminToolAllowed,
  parseAdminToolsDeclaration,
} from "../../src/permissions/admin-tools.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Workspace, WorkspaceRole } from "../../src/workspace/types.ts";

function identity(id: string, orgRole: OrgRole = "member"): UserIdentity {
  return { id, email: `${id}@example.com`, displayName: id, orgRole, preferences: {} };
}

function workspace(members: Array<{ userId: string; role: WorkspaceRole }>): Workspace {
  return {
    id: "ws_acme",
    name: "Acme",
    members,
    connectors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function hostMeta(adminTools: unknown): HostManifestMeta {
  return { host_version: "1.5", admin_tools: adminTools } as HostManifestMeta;
}

const DECLARED: AdminToolsDeclaration = { kind: "names", names: ["configure"] };
const ALL: AdminToolsDeclaration = { kind: "all", reason: "admin_tools is not a list" };
const names = (...n: string[]): AdminToolsDeclaration => ({ kind: "names", names: n });
const WS = workspace([
  { userId: "u_admin", role: "admin" },
  { userId: "u_member", role: "member" },
]);

describe("isAdminToolAllowed", () => {
  test("refuses a workspace member a declared tool", () => {
    expect(isAdminToolAllowed(identity("u_member"), WS, DECLARED, "configure")).toBe(false);
  });

  test("allows a workspace admin a declared tool", () => {
    expect(isAdminToolAllowed(identity("u_admin"), WS, DECLARED, "configure")).toBe(true);
  });

  test("refuses an org admin who is not a member of the workspace", () => {
    expect(isAdminToolAllowed(identity("u_org", "admin"), WS, DECLARED, "configure")).toBe(false);
    expect(isAdminToolAllowed(identity("u_owner", "owner"), WS, DECLARED, "configure")).toBe(
      false,
    );
  });

  test("refuses when there is no identity", () => {
    expect(isAdminToolAllowed(null, WS, DECLARED, "configure")).toBe(false);
    expect(isAdminToolAllowed(undefined, WS, DECLARED, "configure")).toBe(false);
  });

  test("allows anyone an undeclared tool, identity or not", () => {
    expect(isAdminToolAllowed(identity("u_member"), WS, DECLARED, "search")).toBe(true);
    expect(isAdminToolAllowed(null, WS, DECLARED, "search")).toBe(true);
    expect(isAdminToolAllowed(identity("u_member"), WS, undefined, "configure")).toBe(true);
  });

  test("a malformed declaration gates every tool, and an admin still passes", () => {
    expect(isAdminToolAllowed(identity("u_member"), WS, ALL, "search")).toBe(false);
    expect(isAdminToolAllowed(null, WS, ALL, "search")).toBe(false);
    expect(isAdminToolAllowed(identity("u_admin"), WS, ALL, "search")).toBe(true);
  });
});

describe("parseAdminToolsDeclaration", () => {
  const parse = (raw: unknown) => parseAdminToolsDeclaration(hostMeta(raw), "ai.acme/crm");

  test("reads bare names, deduped", () => {
    expect(parse(["configure", "rotate", "configure"])).toEqual(names("configure", "rotate"));
  });

  test("declares nothing when absent or empty", () => {
    expect(parseAdminToolsDeclaration(undefined, "ai.acme/crm")).toBeUndefined();
    expect(parseAdminToolsDeclaration({ host_version: "1.5" }, "ai.acme/crm")).toBeUndefined();
    expect(parse([])).toBeUndefined();
  });

  test("declares nothing for a host block that is not an object", () => {
    for (const host of ["1.0", 7]) {
      expect(parseAdminToolsDeclaration(host as unknown as HostManifestMeta, "ai.acme/crm")).toBeUndefined();
    }
  });

  // The field only narrows, so dropping any part of it would widen access.
  test("gates every tool when the declaration is not a list, null included", () => {
    for (const raw of ["configure", { configure: true }, null, 7]) {
      expect(parse(raw)?.kind).toBe("all");
    }
  });

  test("gates every tool when any entry is not a bare tool name", () => {
    for (const bad of ["", 7, null, "configure ", "has space", "x".repeat(129)]) {
      expect(parse(["configure", bad, "rotate"])?.kind).toBe("all");
    }
  });

  test("gates every tool past the cap rather than ignoring the rest", () => {
    const at = Array.from({ length: 64 }, (_, i) => `tool_${i}`);
    expect(parse(at)?.kind).toBe("names");
    expect(parse([...at, "tool_64"])?.kind).toBe("all");
  });
});

describe("the catalog projection", () => {
  function detail(host: Record<string, unknown>): ServerDetail {
    return {
      name: "ai.acme/crm",
      description: "Acme",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://crm.acme.test/mcp" }],
      _meta: { "ai.nimblebrain/host": host },
    } as ServerDetail;
  }

  test("carries admin_tools onto the catalog entry", () => {
    const entry = serverDetailToCatalogEntry(
      detail({ host_version: "1.5", admin_tools: ["configure"] }),
    );
    expect(entry?.adminTools).toEqual(names("configure"));
  });

  test("keeps the entry, gating every tool, when admin_tools is malformed", () => {
    // Enforcement reads the live catalog, so dropping the entry would un-gate
    // an installed connector.
    const entry = serverDetailToCatalogEntry(detail({ host_version: "1.5", admin_tools: "configure" }));
    expect(entry?.adminTools?.kind).toBe("all");
  });

  test("omits the field when nothing is declared", () => {
    const entry = serverDetailToCatalogEntry(detail({ host_version: "1.5" }));
    expect(entry && "adminTools" in entry).toBe(false);
  });
});

describe("adminToolDenial", () => {
  test("is the structured refusal, naming who can act and nothing else", () => {
    const denied = adminToolDenial("ai-acme-crm", "configure");
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      error: "workspace_admin_required",
      connector: "ai-acme-crm",
      tool: "configure",
    });
    const text = denied.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("Only a workspace admin can use");
  });
});

describe("filterAdmittedTools", () => {
  const tools = [
    { name: "ai-acme-crm__configure" },
    { name: "ai-acme-crm__search" },
    { name: "nb__search" },
    { name: "noseparator" },
  ];

  test("drops only what the admission refuses", () => {
    const admission = {
      admits: (server: string, tool: string) => !(server === "ai-acme-crm" && tool === "configure"),
    };
    expect(filterAdmittedTools(tools, admission).map((t) => t.name)).toEqual([
      "ai-acme-crm__search",
      "nb__search",
      "noseparator",
    ]);
  });

  test("keeps everything for an admin", () => {
    expect(filterAdmittedTools(tools, ADMIT_ALL)).toHaveLength(4);
  });
});

describe("adminToolsContractWarnings", () => {
  const tool = (name: string): Tool => ({ name, description: name, inputSchema: {}, source: "s" });

  test("warns about a name the kernel calls itself", () => {
    const warnings = adminToolsContractWarnings({
      connector: "acme",
      adminTools: names("workspace_ready", "set_url"),
      lifecycle: { on_ready: "workspace_ready" },
      hooks: [{ vendor: "acme", route: "/in", register_tool: "set_url" }],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('lifecycle "on_ready"');
    expect(warnings[1]).toContain('hook "acme" register_tool');
  });

  test("warns about an unadvertised name only when the tool list is known", () => {
    const opts = { connector: "acme", adminTools: names("configure", "ghost") };
    expect(adminToolsContractWarnings(opts)).toEqual([]);
    const warnings = adminToolsContractWarnings({ ...opts, tools: [tool("configure")] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"ghost"');
    expect(warnings[0]).toContain("regardless");
  });

  test("says nothing for a clean declaration", () => {
    expect(
      adminToolsContractWarnings({
        connector: "acme",
        adminTools: names("configure"),
        lifecycle: { on_ready: "workspace_ready" },
        tools: [tool("configure"), tool("workspace_ready")],
      }),
    ).toEqual([]);
  });

  test("a malformed declaration is one warning, naming the connector and the reason", () => {
    const warnings = adminToolsContractWarnings({
      connector: "acme",
      adminTools: ALL,
      tools: [tool("configure")],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"acme"');
    expect(warnings[0]).toContain("admin_tools is not a list");
    expect(warnings[0]).toContain("every tool");
  });
});
