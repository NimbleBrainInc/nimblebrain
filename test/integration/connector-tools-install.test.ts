import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { installTestCredentialStore } from "../helpers/credential-store.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

/**
 * Integration coverage for T010's `manage_connectors.install` contract:
 *
 *   1. **Persisted shape**: after a successful install into a shared
 *      workspace, the on-disk `ConnectorInstance` carries
 *      `wsId: <picked>` and `oauthScope: "workspace"`. The legacy
 *      `oauthScope: "user"` literal is gone (T008) and stays gone —
 *      we read `workspace.json` directly to pin this.
 *
 *   2. **Every workspace installs the same way**: installing into a
 *      workspace the caller alone belongs to records that workspace's
 *      opaque id and the same `oauthScope: "workspace"` ref shape as a
 *      shared install — no workspace is a special install target.
 *
 *   3. **Default to the request workspace; hard-error only with none**:
 *      a tool call with no `wsId` argument installs into the request's
 *      workspace (`getWorkspaceId()`, set from the `/w/<slug>` route the
 *      shell is on) — the same selector every sibling action uses, so an
 *      install and its later connect / list / status can't diverge. When
 *      the context carries NO workspace (neither session header nor
 *      explicit arg) the tool hard-errors and writes nothing: there's
 *      still no default workspace that would pool credentials across
 *      tenants.
 *
 *   4. **Explicit wsId overrides the request workspace**: a caller may
 *      pass `wsId` to install into a workspace other than the session
 *      header (direct API / MCP callers). The web shell no longer does
 *      this — it installs where the route points — but the override
 *      stays supported. Pins audit attribution per install.
 *
 * The Runtime is stubbed to the handlers' actual usage; the full
 * Runtime.start() pipeline is exercised by `cross-workspace-chat`.
 */

const ADMIN: UserIdentity = {
  id: "usr_admin_t010",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

interface Harness {
  workDir: string;
  sharedWsId: string;
  personalWsId: string;
  workspaceStore: WorkspaceStore;
  tool: ReturnType<typeof createManageConnectorsTool>;
  runtime: Runtime;
}

async function buildHarness(
  opts: { sessionWsId: string | null } = { sessionWsId: null },
): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-install-t010-"));
  const sharedWsId = "ws_003eba8844413cd9";

  const credStore = installTestCredentialStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  const workspaceRegistry = new ToolRegistry();

  // Two workspaces, ADMIN admin of both:
  //   - shared — ADMIN plus (conceptually) others
  //   - own — ADMIN alone, the kind provisioning gives a new user
  await seedWorkspace(workspaceStore, sharedWsId, { name: "Helix" });
  await workspaceStore.addMember(sharedWsId, ADMIN.id, "admin");
  const ownWs = await workspaceStore.create("Admin's workspace", {
    members: [{ userId: ADMIN.id, role: "admin" }],
  });
  const personalWsId = ownWs.id;

  const runtime = {
    getWorkDir: () => workDir,
    getCredentialStore: () => credStore,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getConnectorCatalog: () => new ConnectorCatalog(CONNECTOR_FIXTURE_DIR),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () => ({
      deleteConnector: async () => {},
    }),
    getUserStore: () => ({ get: async () => null }),
    getUserConnectorStore: () => ({ get: async () => null }),
    getConnectorInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => opts.sessionWsId,
  };
  const tool = createManageConnectorsTool(ctx);

  return { workDir, sharedWsId, personalWsId, workspaceStore, tool, runtime };
}

function dcrEntry(): CatalogListing {
  return {
    id: "ai.granola/mcp",
    name: "Granola",
    description: "Meeting notes",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.granola.ai/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

describe("manage_connectors.install (T010) — persisted shape + hard-error", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("install into ws_003eba8844413cd9 persists ConnectorRef with oauthScope=workspace + wsId=ws_003eba8844413cd9 on disk", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { wsId?: string; scope?: string };
    expect(sc.wsId).toBe(h.sharedWsId);
    expect(sc.scope).toBe("workspace");

    // Read workspace.json directly. The persisted ConnectorRef must
    // carry `oauthScope: "workspace"` — never `"user"` (T008 removed
    // that literal; this test pins it stays gone).
    const wsDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const installed = (wsDoc.connectors as Array<{ url?: string; oauthScope?: string }>).find(
      (b) => b.url === "https://mcp.granola.ai/mcp",
    );
    expect(installed).toBeDefined();
    expect(installed?.oauthScope).toBe("workspace");
    // No "user" literal anywhere in the persisted record. Defense-
    // in-depth grep: serialize the whole file and look for the legacy
    // value. This catches a regression that resurrected the literal
    // in a different field.
    const raw = readFileSync(
      join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"),
      "utf-8",
    );
    expect(raw).not.toContain('"oauthScope":"user"');
    expect(raw).not.toContain('"oauthScope": "user"');
  });

  test("install into a workspace the caller alone belongs to records its id and the shared ref shape", async () => {
    const personalWsId = h.personalWsId;
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: personalWsId,
    });
    expect(result.isError).toBe(false);
    expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "in this workspace",
    );
    const sc = result.structuredContent as { wsId?: string };
    expect(sc.wsId).toBe(personalWsId);

    // Persisted ref shape — same `oauthScope: "workspace"` shape as
    // shared installs. Who belongs to the target workspace does not
    // change the connector ref.
    const wsDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", personalWsId, "workspace.json"), "utf-8"),
    );
    const installed = (wsDoc.connectors as Array<{ url?: string; oauthScope?: string }>).find(
      (b) => b.url === "https://mcp.granola.ai/mcp",
    );
    expect(installed?.oauthScope).toBe("workspace");
  });

  test("hard-errors when neither a session workspace nor a wsId arg is present", async () => {
    // No workspace anywhere: the default harness has a null session
    // workspace (`getWorkspaceId()` → null) and the call passes no
    // `wsId`. With nothing to install into, the tool hard-errors and
    // writes nothing — install defaults to the *request* workspace, but
    // there's still no default workspace that would pool credentials
    // across tenants when no workspace is in context at all. Pin hard
    // error + no on-disk writes.
    const result = await h.tool.handler({ action: "install", entry: dcrEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("wsid is required");

    // Workspace.json for both workspaces shows ZERO connectors installed
    // — the hard-error path wrote nothing.
    const sharedDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const personalDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.personalWsId, "workspace.json"), "utf-8"),
    );
    expect((sharedDoc.connectors as unknown[]).length).toBe(0);
    expect((personalDoc.connectors as unknown[]).length).toBe(0);
  });

  test("install with no wsId arg defaults to the session-header workspace", async () => {
    // The fix: with the target picker gone, the web shell sends no
    // `wsId` and the tool installs into the request's workspace
    // (`getWorkspaceId()` → the `/w/<slug>` route header). That's the
    // same workspace the follow-up connect / list / status calls read,
    // so they can't land in different workspaces — the prior divergence
    // surfaced as "Connector not installed" on Connect.
    h = await buildHarness({ sessionWsId: h.sharedWsId });
    const result = await h.tool.handler({ action: "install", entry: dcrEntry() });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { wsId?: string };
    expect(sc.wsId).toBe(h.sharedWsId);
    const sharedDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    expect((sharedDoc.connectors as unknown[]).length).toBe(1);
  });

  test("explicit wsId arg overrides the session-header workspace", async () => {
    // A caller can still target a workspace other than the session
    // header by passing `wsId` explicitly (direct API / MCP callers).
    // Session header points at sharedWsId; the explicit arg names
    // the caller's own workspace, so the install lands there and sharedWsId
    // stays empty. The web shell no longer exercises this (it omits
    // wsId), but the override must keep working.
    h = await buildHarness({ sessionWsId: h.sharedWsId });
    const personalWsId = h.personalWsId;
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: personalWsId, // explicit target overrides the session header
    });
    expect(result.isError).toBe(false);
    const sharedDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const personalDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", personalWsId, "workspace.json"), "utf-8"),
    );
    expect((sharedDoc.connectors as unknown[]).length).toBe(0);
    expect((personalDoc.connectors as unknown[]).length).toBe(1);
  });

  test("DCR connector binds its overlay via the canonical (reverse-DNS) identity, not the slug", async () => {
    // The overlay repo is keyed by connector identity (`granola/SKILL.md`).
    // Install must derive that identity from the canonical `entry.id`
    // (`ai.granola/mcp` → `granola`), NOT the slugified serverName
    // (`ai-granola-mcp`). This fixture serves the overlay ONLY at the correct
    // `/granola/SKILL.md` path, so a regression that derives the identity from
    // the slug 404s and binds nothing — failing the assertion below.
    const overlayBody =
      "---\nname: granola-usage\ndescription: How to use Granola.\n---\nUse Granola carefully.\n";
    const fetchOnlyGranola = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      return u.includes("/granola/SKILL.md")
        ? new Response(overlayBody, { status: 200 })
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    h.runtime.getLifecycle().setConnectorSkillFetch(fetchOnlyGranola);

    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(false);

    const wsDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const installed = (
      wsDoc.connectors as Array<{ url?: string; skillsLock?: Array<{ identity: string }> }>
    ).find((b) => b.url === "https://mcp.granola.ai/mcp");
    expect(installed?.skillsLock?.[0]?.identity).toBe("granola");
  });
});

// Suppress unused-helper warnings.
void textContent;
