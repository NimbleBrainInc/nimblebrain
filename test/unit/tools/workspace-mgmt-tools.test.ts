import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { User } from "../../../src/identity/user.ts";
import { UserStore } from "../../../src/identity/user.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../../../src/tools/in-process-app.ts";
import {
  createManageWorkspacesTool,
  type ManageWorkspacesContext,
} from "../../../src/tools/workspace-mgmt-tools.ts";
import { GENERATED_WORKSPACE_ID_RE } from "../../../src/workspace/workspace-id-pattern.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { parseResult, resultText } from "../../helpers/tool-result.ts";

// ── Helpers ───────────────────────────────────────────────────────

// ── Setup ─────────────────────────────────────────────────────────

let workDir: string;
let store: WorkspaceStore;
let userStore: UserStore;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;
/** What the stub catalog serves; a test that names connectors seeds it. */
let catalogEntries: ConnectorCatalogEntry[];

/**
 * A runtime stub whose `deleteWorkspace` archives through the real store and
 * reports no connectors.
 *
 * These are the TOOL's tests — the gate, the argument parsing, the prose, the
 * not-found answer. The cascade itself is the runtime's, and is driven against
 * a real `Runtime.start()` in
 * `test/integration/workspace-delete-cascade.test.ts`; stubbing it here would
 * assert a double.
 */
function makeCtx(): ManageWorkspacesContext {
  return {
    getIdentity: () => currentIdentity,
    workspaceStore: store,
    runtime: {
      deleteWorkspace: async (wsId: string) => ({
        deleted: await store.delete(wsId),
        connectors: [],
      }),
      getConnectorCatalog: () => ({
        catalogByUrl: async () => new Map(catalogEntries.map((e) => [e.url, e])),
        catalogByIdMap: async () => new Map(catalogEntries.map((e) => [e.id, e])),
      }),
    } as unknown as Runtime,
    userStore,
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-ws-mgmt-test-"));
  store = new WorkspaceStore(workDir);
  userStore = new UserStore(workDir);
  catalogEntries = [];
  currentIdentity = makeIdentity({
    id: "usr_admin000000001",
    email: "admin@example.com",
    displayName: "Admin",
    orgRole: "admin",
  });
  tool = createManageWorkspacesTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_workspaces", () => {
  describe("role enforcement", () => {
    test("admin can create a workspace", async () => {
      const result = await tool.handler({
        action: "create",
        name: "Test Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { workspace: { id: string; name: string } };
      expect(parsed.workspace.name).toBe("Test Workspace");
    });

    test("owner can create a workspace", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        name: "Owner Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { workspace: { name: string } };
      expect(parsed.workspace.name).toBe("Owner Workspace");
    });

    test("member gets permission denied", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        name: "Forbidden",
      });

      expect(result.isError).toBe(false);
      expect(resultText(result)).toContain("You don't have permission to manage workspaces");
    });

    test("null identity gets permission denied", async () => {
      currentIdentity = null;
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({ action: "list" });

      expect(resultText(result)).toContain("You don't have permission to manage workspaces");
    });
  });

  describe("create", () => {
    test("creates workspace with scaffolded directory", async () => {
      const result = await tool.handler({
        action: "create",
        name: "My Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspace: { id: string; name: string; createdAt: string };
      };
      // The id is opaque and name-independent — NOT derived from the name.
      expect(parsed.workspace.id).toMatch(/^ws_[0-9a-f]{16}$/);
      expect(parsed.workspace.name).toBe("My Workspace");
      expect(parsed.workspace.createdAt).toBeTruthy();

      // Verify directory was scaffolded under the opaque id.
      const wsDir = join(workDir, "workspaces", parsed.workspace.id);
      expect(existsSync(join(wsDir, "data", ".gitkeep"))).toBe(true);
      expect(existsSync(join(wsDir, "skills", ".gitkeep"))).toBe(true);
    });

    test("refuses a slug at the schema boundary and creates nothing", async () => {
      // Served the way the runtime serves it: the in-process MCP server
      // validates arguments against the tool's input schema before the
      // handler runs. The id of a created workspace is always generated.
      const source = defineInProcessApp(
        { name: "nb", version: "1.0.0", tools: [tool] },
        new NoopEventSink(),
      );
      await source.start();
      try {
        const refused = await source.execute("manage_workspaces", {
          action: "create",
          name: "My Workspace",
          slug: "custom_slug",
        });
        expect(refused.isError).toBe(true);
        const { error } = parseResult(refused) as { error: string };
        expect(error).toContain('Invalid arguments for "manage_workspaces"');
        expect(error).toContain("must NOT have additional properties");
        expect(await store.list()).toEqual([]);

        const created = await source.execute("manage_workspaces", {
          action: "create",
          name: "My Workspace",
        });
        expect(created.isError).toBe(false);
        const [ws] = await store.list();
        expect(ws?.id).toMatch(GENERATED_WORKSPACE_ID_RE);
      } finally {
        await source.stop();
      }
    });

    test("declares no id or slug input", () => {
      const schema = tool.inputSchema as {
        properties: Record<string, unknown>;
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties)).not.toContain("slug");
      expect(Object.keys(schema.properties)).not.toContain("id");
    });

    test("creates workspace with connectors, reporting them by name", async () => {
      catalogEntries = [
        { id: "com.example/echo", name: "Echo", url: "https://echo.example.com/mcp" },
      ] as ConnectorCatalogEntry[];
      const result = await tool.handler({
        action: "create",
        name: "Connector Workspace",
        connectors: [{ url: "https://echo.example.com/mcp", serverName: "echo" }],
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspace: { id: string; connectors: Array<Record<string, unknown>> };
      };
      expect(parsed.workspace.connectors).toEqual([{ serverName: "echo", name: "Echo" }]);
      const stored = await store.get(parsed.workspace.id);
      expect(stored?.connectors[0]?.url).toBe("https://echo.example.com/mcp");
    });

    test("requires name", async () => {
      const result = await tool.handler({ action: "create" });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("name is required");
    });

    test("two creates with the same name get distinct generated ids", async () => {
      const a = parseResult(await tool.handler({ action: "create", name: "Dupe" })) as {
        workspace: { id: string };
      };
      const b = parseResult(await tool.handler({ action: "create", name: "Dupe" })) as {
        workspace: { id: string };
      };
      expect(a.workspace.id).toMatch(GENERATED_WORKSPACE_ID_RE);
      expect(b.workspace.id).toMatch(GENERATED_WORKSPACE_ID_RE);
      expect(a.workspace.id).not.toBe(b.workspace.id);
    });
  });

  describe("creator seating (deadlock fix)", () => {
    test("creating a shared workspace seats the creator as an admin member", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Seated Workspace",
      });

      expect(createResult.isError).toBe(false);
      const created = parseResult(createResult) as {
        workspace: { id: string; memberCount: number };
      };
      // The success response reflects the seated member.
      expect(created.workspace.memberCount).toBe(1);

      // The persisted workspace has the creator seated as an admin member.
      const ws = await store.get(created.workspace.id);
      expect(ws?.members).toEqual([{ userId: currentIdentity!.id, role: "admin" }]);
    });

    test("creator can immediately manage members of the new workspace via the strict workspace-admin path", async () => {
      // The creator is an org admin at create time (create requires it), and a
      // user record so they could be added/removed.
      const creator: User = await userStore.create({
        email: "creator@example.com",
        displayName: "Creator",
        orgRole: "admin",
      });
      const newMember: User = await userStore.create({
        email: "newmember@example.com",
        displayName: "New Member",
        orgRole: "member",
      });

      currentIdentity = makeIdentity({
        id: creator.id,
        email: creator.email,
        displayName: creator.displayName,
        orgRole: "admin",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const createResult = await tool.handler({
        action: "create",
        name: "Creator Managed",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      // Drop the org-admin role entirely — the creator now relies SOLELY on
      // their seated workspace-admin membership. This is the strict-policy
      // world where the org-admin bypass is gone. Without seating, this path
      // would deadlock (canManageMembers would return false).
      currentIdentity = { ...currentIdentity, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const addResult = await tool.handler({
        action: "add_member",
        workspaceId: created.workspace.id,
        userId: newMember.id,
      });

      expect(addResult.isError).toBe(false);
      const added = parseResult(addResult) as {
        added: { userId: string; role: string };
        workspace: { memberCount: number };
      };
      expect(added.added.userId).toBe(newMember.id);
      // creator (admin, seated on create) + newMember.
      expect(added.workspace.memberCount).toBe(2);
    });
  });

  describe("update", () => {
    test("updates workspace name", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Original",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const updateResult = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
        name: "Updated",
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as {
        workspace: { name: string; updatedAt: string };
      };
      expect(updated.workspace.name).toBe("Updated");
    });

    test("updates workspace connectors", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Connector Update",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const updateResult = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
        connectors: [
          { url: "https://echo.example.com/mcp", serverName: "echo" },
          { url: "https://bash.example.com/mcp", serverName: "bash" },
        ],
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as {
        workspace: { connectors: Array<Record<string, unknown>> };
      };
      // Uncatalogued, so each is named by its server name; the ref stays in the store.
      expect(updated.workspace.connectors).toEqual([
        { serverName: "echo", name: "echo" },
        { serverName: "bash", name: "bash" },
      ]);
      const stored = await store.get(created.workspace.id);
      expect(stored?.connectors.map((c) => c.url)).toEqual([
        "https://echo.example.com/mcp",
        "https://bash.example.com/mcp",
      ]);
    });

    test("refuses a connector row with no reachable url", async () => {
      // The schema requires `url` but admits any string. A row that reaches the
      // store without a reachable URL is a connector nothing can connect to,
      // and every reader downstream would have to defend against it — so it is
      // refused at the boundary that creates it. Covers the empty string and
      // the legacy by-name shape.
      const created = parseResult(await tool.handler({ action: "create", name: "Bad Rows" })) as {
        workspace: { id: string };
      };

      for (const bad of [{ url: "" }, { name: "@nimblebraininc/echo" }, { url: "ftp://x/mcp" }]) {
        const result = await tool.handler({
          action: "update",
          workspaceId: created.workspace.id,
          connectors: [bad],
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain("http(s) URL");
      }
    });

    test("an archive failure names the teardown that already ran, not a no-op", async () => {
      const created = parseResult(await tool.handler({ action: "create", name: "Stuck" })) as {
        workspace: { id: string };
      };

      tool = createManageWorkspacesTool({
        ...makeCtx(),
        runtime: {
          deleteWorkspace: async () => ({
            deleted: false,
            deleteError: "EEXIST: file already exists",
            connectors: [
              { serverName: "com-example-alpha", ok: true, secrets: { deleted: [], failed: [] } },
            ],
          }),
        } as unknown as Runtime,
      });

      const result = await tool.handler({
        action: "delete",
        workspaceId: created.workspace.id,
      });

      expect(result.isError).toBe(true);
      // `deleted: false` with a `deleteError` is NOT the store's idempotent
      // not-found, and must not be reported as one: the connectors are gone.
      expect(resultText(result)).not.toContain("Workspace not found");
      expect(resultText(result)).toContain("EEXIST");
      expect(resultText(result)).toContain("Tore down 1 connector.");
      expect(resultText(result)).toContain("cannot be undone");
      // And it claims nothing about where the record ended up. The store
      // throws on both sides of its rename, so either claim is wrong half the
      // time — see `handleDelete`.
      expect(resultText(result)).not.toContain("still on disk");
      expect(resultText(result)).not.toContain("is archived");
    });

    test("requires workspaceId", async () => {
      const result = await tool.handler({
        action: "update",
        name: "No ID",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("workspaceId is required");
    });

    test("returns error for non-existent workspace", async () => {
      const result = await tool.handler({
        action: "update",
        workspaceId: "ws_nonexistent",
        name: "Ghost",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Workspace not found");
    });

    test("requires at least one field to update", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Unchanged",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const result = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("No fields to update");
    });
  });

  describe("delete", () => {
    test("deletes workspace and removes directory", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Deletable",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const wsDir = join(workDir, "workspaces", created.workspace.id);
      expect(existsSync(wsDir)).toBe(true);

      const deleteResult = await tool.handler({
        action: "delete",
        workspaceId: created.workspace.id,
      });

      expect(deleteResult.isError).toBe(false);
      const parsed = parseResult(deleteResult) as { deleted: boolean; workspaceId: string };
      expect(parsed.deleted).toBe(true);

      // Verify directory is gone
      expect(existsSync(wsDir)).toBe(false);
    });

    test("reports what the delete tore down, and names what did not", async () => {
      const created = parseResult(await tool.handler({ action: "create", name: "Wired" })) as {
        workspace: { id: string };
      };

      tool = createManageWorkspacesTool({
        ...makeCtx(),
        runtime: {
          deleteWorkspace: async (wsId: string) => ({
            deleted: await store.delete(wsId),
            connectors: [
              { serverName: "com-example-alpha", ok: true, secrets: { deleted: [], failed: [] } },
              {
                serverName: "com-example-beta",
                ok: false,
                error: "vendor unreachable",
                secrets: { deleted: [], failed: [] },
              },
            ],
          }),
        } as unknown as Runtime,
      });

      const result = await tool.handler({
        action: "delete",
        workspaceId: created.workspace.id,
      });

      expect(result.isError).toBe(false);
      // The record is archived, so this sentence is the last place the connector
      // whose grant may still be live at a vendor is nameable.
      expect(resultText(result)).toContain("Tore down 2 connectors.");
      expect(resultText(result)).toContain('"com-example-beta"');
      expect(resultText(result)).not.toContain('"com-example-alpha"');

      const parsed = parseResult(result) as { connectors: Array<{ serverName: string }> };
      expect(parsed.connectors.map((c) => c.serverName)).toEqual([
        "com-example-alpha",
        "com-example-beta",
      ]);
    });

    test("requires workspaceId", async () => {
      const result = await tool.handler({ action: "delete" });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("workspaceId is required");
    });

    test("returns error for non-existent workspace", async () => {
      const result = await tool.handler({
        action: "delete",
        workspaceId: "ws_nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Workspace not found");
    });
  });

  describe("list", () => {
    test("returns all workspaces with member counts and connectors", async () => {
      await tool.handler({ action: "create", name: "Alpha" });
      await tool.handler({ action: "create", name: "Beta" });

      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as {
        workspaces: Array<{
          id: string;
          name: string;
          memberCount: number;
          connectors: unknown[];
          createdAt: string;
        }>;
      };
      expect(parsed.workspaces).toHaveLength(2);
      const sorted = [...parsed.workspaces].sort((a, b) => a.name.localeCompare(b.name));
      expect(sorted[0].name).toBe("Alpha");
      // The creator is auto-seated as an admin member on create, so each
      // freshly created shared workspace starts with exactly one member.
      expect(sorted[0].memberCount).toBe(1);
      expect(sorted[0].connectors).toEqual([]);
      expect(sorted[1].name).toBe("Beta");
    });

    test("names each connector from the catalog and never returns the ref", async () => {
      catalogEntries = [
        {
          id: "com.example/echo",
          name: "Echo",
          url: "https://echo.example.com/mcp",
          iconUrl: "https://static.example.com/echo.svg",
        },
        { id: "com.example/mail", name: "Mail", url: "https://catalog.example.com/mail" },
      ] as ConnectorCatalogEntry[];
      await tool.handler({ action: "create", name: "Alpha" });
      const [ws] = await store.list();
      await store.update(ws.id, {
        connectors: [
          // Catalogued by URL, carrying an inline secret the listing must not echo.
          {
            url: "https://echo.example.com/mcp",
            serverName: "echo",
            transport: { auth: { type: "bearer", token: "inline-secret" } },
          },
          // Brokered: a per-install session URL, catalogued by the stamped id.
          {
            url: "https://session.example.com/abc",
            serverName: "mail",
            brokered: { provider: "composio", connectorId: "com.example/mail" },
          },
          // Uncatalogued and unnamed: falls back to the derived server name.
          { url: "https://other.example.com/mcp" },
        ],
      });

      const parsed = parseResult(await tool.handler({ action: "list" })) as {
        workspaces: Array<{ connectors: Array<Record<string, unknown>> }>;
      };
      const connectors = parsed.workspaces[0].connectors;
      expect(connectors.map((c) => c.name)).toEqual(["Echo", "Mail", connectors[2].serverName]);
      expect(connectors[2].serverName).toBeTruthy();
      expect(connectors.map((c) => c.iconUrl)).toEqual([
        "https://static.example.com/echo.svg",
        undefined,
        undefined,
      ]);
      expect(Object.keys(connectors[0]).sort()).toEqual(["iconUrl", "name", "serverName"]);
      for (const c of connectors.slice(1)) {
        expect(Object.keys(c).sort()).toEqual(["name", "serverName"]);
      }
      expect(JSON.stringify(parsed)).not.toContain("inline-secret");
    });

    test("returns empty array when no workspaces exist", async () => {
      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as { workspaces: unknown[] };
      expect(parsed.workspaces).toHaveLength(0);
    });
  });

  describe("recovering a workspace with no admin", () => {
    // `add_member` rejects an unknown user, so the operator must exist in the store.
    async function seatOperator(): Promise<void> {
      const operator = await userStore.create({
        email: "op@example.com",
        displayName: "Op",
        orgRole: "admin",
      });
      currentIdentity = { ...currentIdentity!, id: operator.id };
      tool = createManageWorkspacesTool(makeCtx());
    }

    test("org admin seats themselves as admin with add_member, then manages it with org role dropped", async () => {
      await seatOperator();
      const member: User = await userStore.create({
        email: "m@example.com",
        displayName: "M",
        orgRole: "member",
      });
      const ws = await store.create("Stranded");
      await store.addMember(ws.id, member.id, "member");

      const seat = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        userId: currentIdentity!.id,
        role: "admin",
      });
      expect(seat.isError).toBe(false);

      // Drop org admin; the seated workspace-admin membership alone now grants management.
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());
      const promote = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: member.id,
        role: "admin",
      });
      expect(promote.isError).toBe(false);
    });

    test("org admin who is a plain member promotes themselves in place with update_member", async () => {
      await seatOperator();
      const ws = await store.create("Stranded");
      await store.addMember(ws.id, currentIdentity!.id, "member");

      const result = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: currentIdentity!.id,
        role: "admin",
      });

      expect(result.isError).toBe(false);
      const persisted = await store.get(ws.id);
      expect(persisted?.members).toEqual([
        expect.objectContaining({ userId: currentIdentity!.id, role: "admin" }),
      ]);
    });
  });

  describe("archives", () => {
    async function deleteViaTool(name: string): Promise<string> {
      const created = parseResult(await tool.handler({ action: "create", name })) as {
        workspace: { id: string };
      };
      await tool.handler({ action: "delete", workspaceId: created.workspace.id });
      return created.workspace.id;
    }

    test("list_archives shows a deleted workspace, and an archive with no workspace.json as unknown", async () => {
      const id = await deleteViaTool("Gone");
      await mkdir(join(store.getArchivedDir(), "ws_orphan"), { recursive: true });

      const result = await tool.handler({ action: "list_archives" });

      expect(result.isError).toBe(false);
      const { archives } = parseResult(result) as {
        archives: Array<{ name: string; workspaceId: string | null; workspaceName: string | null }>;
      };
      expect(archives.find((a) => a.name === id)?.workspaceName).toBe("Gone");
      const orphan = archives.find((a) => a.name === "ws_orphan");
      expect(orphan?.workspaceId).toBeNull();
      expect(orphan?.workspaceName).toBeNull();
    });

    test("a non-admin gets the permission-denied result, not an empty list", async () => {
      await deleteViaTool("Gone");
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      for (const action of ["list_archives", "purge_archive"]) {
        const result = await tool.handler({ action, archive: "ws_anything" });
        expect(result.structuredContent).toBeUndefined();
        expect(resultText(result)).toContain("You don't have permission to manage workspaces");
      }
    });

    test("purge_archive removes one archive; purging it again is a clean no-op", async () => {
      const gone = await deleteViaTool("Gone");
      const kept = await deleteViaTool("Kept");

      const first = await tool.handler({ action: "purge_archive", archive: gone });
      expect(first.isError).toBe(false);
      expect((parseResult(first) as { purged: boolean }).purged).toBe(true);
      expect(existsSync(join(store.getArchivedDir(), gone))).toBe(false);
      expect(existsSync(join(store.getArchivedDir(), kept))).toBe(true);

      const second = await tool.handler({ action: "purge_archive", archive: gone });
      expect(second.isError).toBe(false);
      expect((parseResult(second) as { purged: boolean }).purged).toBe(false);
    });

    test("purge_archive refuses a traversal and touches nothing", async () => {
      const live = await store.create("Live");
      const liveDir = join(workDir, "workspaces", live.id);

      const result = await tool.handler({
        action: "purge_archive",
        archive: `../workspaces/${live.id}`,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("is not an archive name");
      expect(existsSync(liveDir)).toBe(true);
    });

    test("purge_archive requires an archive name", async () => {
      const result = await tool.handler({ action: "purge_archive" });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("archive is required");
    });
  });

  describe("unknown action", () => {
    test("returns error for unknown action", async () => {
      const result = await tool.handler({ action: "invalid" });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Unknown action: invalid");
    });
  });
});
