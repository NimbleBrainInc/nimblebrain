import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import {
  BUNDLED_STATIC_CATALOG_PATH,
  RegistryStore,
} from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import {
  personalWorkspaceIdFor,
  WorkspaceStore,
} from "../../src/workspace/workspace-store.ts";
import { writeFileSync } from "node:fs";

/**
 * Integration coverage for T010's `manage_connectors.install` contract:
 *
 *   1. **Persisted shape**: after a successful install into a non-
 *      personal workspace, the on-disk `BundleInstance` carries
 *      `wsId: <picked>` and `oauthScope: "workspace"`. The legacy
 *      `oauthScope: "user"` literal is gone (T008) and stays gone —
 *      we read `workspace.json` directly to pin this.
 *
 *   2. **Personal install uses the helper**: installing into the
 *      caller's personal workspace records `wsId ===
 *      personalWorkspaceIdFor(userId)`. The test asserts equality
 *      against the helper's output, not a hand-built template.
 *      `check:personal-workspace-id` lint stays silent.
 *
 *   3. **Hard-error on missing wsId**: a tool call with no `wsId`
 *      argument returns a structured error and writes nothing to
 *      `workspace.json`. Adversarial: pinned because a regression
 *      that silently defaulted would still produce a working
 *      connector for the user, but pool credentials across tenants
 *      for any user who tried to install into shared.
 *
 *   4. **No ambient leak**: `getWorkspaceId()` on the context (the
 *      session-header workspace) is intentionally unrelated to the
 *      picked install target. The install lands in the picked
 *      target, not the session header. Pins Stage 1 lesson 2 (audit
 *      attribution per install).
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

async function buildHarness(opts: { sessionWsId: string | null } = { sessionWsId: null }): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-install-t010-"));
  const sharedWsId = "ws_helix";
  const personalWsId = personalWorkspaceIdFor(ADMIN.id);

  // Disable mpak so ConnectorDirectory doesn't try to fetch.
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated services",
          type: "static",
          enabled: true,
          locked: true,
          url: BUNDLED_STATIC_CATALOG_PATH,
        },
        { id: "mpak", name: "mpak.dev", type: "mpak", enabled: false },
      ],
    }),
  );

  const workspaceStore = new WorkspaceStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();
  const registryStore = new RegistryStore(workDir);

  // Two workspaces:
  //   - shared (admin role) — non-personal
  //   - personal — owner = ADMIN
  await workspaceStore.create("Helix", "helix");
  await workspaceStore.addMember(sharedWsId, ADMIN.id, "admin");
  await workspaceStore.create("Personal", `user_${ADMIN.id}`, {
    isPersonal: true,
    ownerUserId: ADMIN.id,
  });

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () => ({
      deleteConnector: async () => {},
    }),
    getUserStore: () => ({ get: async () => null }),
    getUserConnectorStore: () => ({ get: async () => null }),
    getBundleInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
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

function dcrEntry(): DirectoryEntry {
  return {
    id: "ai.granola/mcp",
    registryId: "bundled-static",
    registryType: "static",
    name: "Granola",
    description: "Meeting notes",
    defaultBinding: "personal",
    install: {
      kind: "remote-oauth",
      url: "https://api.granola.test/mcp",
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

  test("install into ws_helix persists BundleRef with oauthScope=workspace + wsId=ws_helix on disk", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { wsId?: string; scope?: string };
    expect(sc.wsId).toBe(h.sharedWsId);
    expect(sc.scope).toBe("workspace");

    // Read workspace.json directly. The persisted BundleRef must
    // carry `oauthScope: "workspace"` — never `"user"` (T008 removed
    // that literal; this test pins it stays gone).
    const wsDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const installed = (wsDoc.bundles as Array<{ url?: string; oauthScope?: string }>).find(
      (b) => b.url === "https://api.granola.test/mcp",
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

  test("personal install records wsId === personalWorkspaceIdFor(userId) — uses the helper, not a hand-built id", async () => {
    const personalWsId = personalWorkspaceIdFor(ADMIN.id);
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: personalWsId,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { wsId?: string };
    // Equality with the helper's output ensures the test stays
    // coupled to the canonical construction site — a future change
    // to `personalWorkspaceIdFor` flows into this assertion
    // automatically. `check:personal-workspace-id` is `src/`-only,
    // so test-side hand-building wouldn't be flagged, but it would
    // drift from production silently. Using the helper here keeps
    // production and test in lockstep.
    expect(sc.wsId).toBe(personalWsId);

    // Persisted ref shape — same `oauthScope: "workspace"` shape as
    // shared installs. The "personal-ness" of the target workspace
    // is a property of the workspace record, NOT the bundle ref.
    const wsDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", personalWsId, "workspace.json"), "utf-8"),
    );
    const installed = (wsDoc.bundles as Array<{ url?: string; oauthScope?: string }>).find(
      (b) => b.url === "https://api.granola.test/mcp",
    );
    expect(installed?.oauthScope).toBe("workspace");
  });

  test("hard-errors when wsId is missing (Stage 1 lesson 3 — no silent fallback)", async () => {
    // Adversarial: a buggy UI omitted `wsId`. Stage 2's invariant is
    // no default-to-personal inside the tool — the only legitimate
    // way to install is for the picker to supply a target. A
    // regression that silently defaulted would still produce a
    // working connector for THIS user, but pool credentials across
    // tenants for any user who tried to install into shared. Pin
    // hard error + no on-disk writes.
    const result = await h.tool.handler({ action: "install", entry: dcrEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("wsid is required");

    // Workspace.json for both workspaces shows ZERO bundles installed
    // — the hard-error path wrote nothing.
    const sharedDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const personalDoc = JSON.parse(
      readFileSync(
        join(h.workDir, "workspaces", h.personalWsId, "workspace.json"),
        "utf-8",
      ),
    );
    expect((sharedDoc.bundles as unknown[]).length).toBe(0);
    expect((personalDoc.bundles as unknown[]).length).toBe(0);
  });

  test("install lands in the picked wsId — NOT the session-header workspace (no ambient leak)", async () => {
    // Audit attribution (Stage 1 lesson 2): the install reaches
    // workspace.json for the picked wsId, not the session header's
    // workspace. We build a fresh harness whose session header
    // points at sharedWsId, and install into personalWsId via the
    // explicit arg. After install, sharedWsId/workspace.json has
    // ZERO bundles; personalWsId/workspace.json has ONE.
    h = await buildHarness({ sessionWsId: h.sharedWsId });
    const personalWsId = personalWorkspaceIdFor(ADMIN.id);
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      wsId: personalWsId, // picker says personal — session says shared
    });
    expect(result.isError).toBe(false);
    const sharedDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", h.sharedWsId, "workspace.json"), "utf-8"),
    );
    const personalDoc = JSON.parse(
      readFileSync(join(h.workDir, "workspaces", personalWsId, "workspace.json"), "utf-8"),
    );
    expect((sharedDoc.bundles as unknown[]).length).toBe(0);
    expect((personalDoc.bundles as unknown[]).length).toBe(1);
  });
});

// Suppress unused-helper warnings.
void textContent;
