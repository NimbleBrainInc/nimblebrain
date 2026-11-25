/**
 * Seed the Plugins page demo's workdir (`bun run dev:plugins-demo`).
 *
 * Dev tooling, not a migration: it runs before every launch of the demo and
 * writes only into the demo's own workdir. Everything goes through the store
 * the runtime itself writes with (`WorkspaceStore`, `UserStore`,
 * `IdentityConnectorStore`, `PermissionStore`, the configured
 * `CredentialStore` behind `McpOAuthRecords`, the skill writer, the
 * conversation store), and each connector row has the shape the matching
 * install path writes (`handleInstallDirectUrl`, `buildRemoteConnectorRef` in
 * `src/tools/connector-tools.ts`). So the runtime boots it like any workdir and
 * derives every plugin's state itself.
 *
 * Idempotent: a workspace is found by name before it is created, a connector
 * row is replaced by server name, and a skill or the conversation is written
 * only when absent. What a person changes in the running demo survives a
 * relaunch, except the URLs of the mock servers, which move with their ports.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SecretsConfig } from "../../../src/config/secrets.ts";
import { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../../src/connectors/catalog/types.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import { IdentityConnectorStore } from "../../../src/identity/connector-store.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { FALLBACK_DEFAULT_MODEL } from "../../../src/model/default-model.ts";
import { PermissionStore } from "../../../src/permissions/permission-store.ts";
import { readSkill, writeSkill } from "../../../src/skills/writer.ts";
import { type CredentialStore, setCredentialStore } from "../../../src/tools/credential-store.ts";
import {
  createCredentialStore,
  registerBuiltinCredentialStoreBackends,
} from "../../../src/tools/credential-store-backend.ts";
import { McpOAuthRecords, setMcpOAuthAuthLost } from "../../../src/tools/mcp-oauth-records.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import type { Workspace, WorkspaceOAuthClient } from "../../../src/workspace/types.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  DEMO_CONVERSATION_ID,
  DEMO_USER_ID,
  DEMO_WORKSPACES,
  type DemoWorkspace,
  MOCK_SERVERS,
  ORG_SKILLS,
  PERSONAL_ACCOUNT,
  PERSONAL_PLUGINS,
  type SkillFixture,
  USER_SKILLS,
  type WorkspacePlugin,
} from "./fixtures.ts";
import { appResourceUri, type MockFleet } from "./mock-servers.ts";

export interface SeedOptions {
  workDir: string;
  catalogDir: string;
  fleet: Pick<MockFleet, "urls" | "failing">;
  /** The `secrets` block of the demo's config, so the seed writes to the backend the runtime reads. */
  secrets?: SecretsConfig;
}

export interface SeedSummary {
  workspaces: { id: string; name: string; plugins: Record<WorkspacePlugin["state"], number> }[];
  personal: number;
  skills: { org: number; workspace: number; user: number };
}

const SEEDED_AT = "2026-11-02T09:00:00.000Z";
const MODEL = FALLBACK_DEFAULT_MODEL;

export async function seedPluginsDemo(opts: SeedOptions): Promise<SeedSummary> {
  registerBuiltinCredentialStoreBackends();
  const credentials = createCredentialStore({ workDir: opts.workDir, secrets: opts.secrets });
  // `McpOAuthRecords` reaches the installed store, as it does inside the runtime.
  setCredentialStore(credentials);

  const { entries } = await new ConnectorCatalog(opts.catalogDir).list({});
  const catalog = new Map(entries.map((e) => [e.id, e]));

  await ensureDevUser(opts.workDir);
  const workspaces = new WorkspaceStore(opts.workDir);
  const summary: SeedSummary = {
    workspaces: [],
    personal: 0,
    skills: { org: 0, workspace: 0, user: 0 },
  };
  const ids = new Map<string, string>();
  for (const demo of DEMO_WORKSPACES) {
    const ws = await ensureWorkspace(workspaces, demo);
    ids.set(demo.name, ws.id);
    await seedWorkspacePlugins(workspaces, ws, demo, { ...opts, credentials, catalog });
    summary.skills.workspace += writeSkills(
      new WorkspaceContext({ wsId: ws.id, workDir: opts.workDir }).getDataPath("skills"),
      demo.skills,
    );
    summary.workspaces.push({ id: ws.id, name: ws.name, plugins: countStates(demo.plugins) });
  }

  summary.personal = await seedPersonalPlugins(opts.workDir, catalog, ids);
  summary.skills.org = writeSkills(join(opts.workDir, "skills"), ORG_SKILLS);
  summary.skills.user = writeSkills(
    join(opts.workDir, "users", DEMO_USER_ID, "skills"),
    USER_SKILLS,
  );

  const first = summary.workspaces[0];
  if (first) await seedConversation(opts.workDir, first.id);
  return summary;
}

function countStates(
  plugins: readonly WorkspacePlugin[],
): SeedSummary["workspaces"][number]["plugins"] {
  const counts = {
    ready: 0,
    failed: 0,
    "needs-sign-in": 0,
    "sign-in-expired": 0,
    "needs-setup": 0,
  };
  for (const p of plugins) counts[p.state] += 1;
  return counts;
}

/** The dev identity's profile, which the dev provider would otherwise create on first request. */
async function ensureDevUser(workDir: string): Promise<void> {
  const users = new UserStore(workDir);
  if (await users.get(DEMO_USER_ID)) return;
  await users.create({
    id: DEMO_USER_ID,
    email: "dev@localhost",
    displayName: "Dev",
    orgRole: "admin",
  });
}

async function ensureWorkspace(store: WorkspaceStore, demo: DemoWorkspace): Promise<Workspace> {
  const existing = (await store.list()).find((ws) => ws.name === demo.name);
  if (existing) return existing;
  return store.create(demo.name, {
    about: demo.about,
    members: [{ userId: DEMO_USER_ID, role: "admin" }],
  });
}

interface WorkspaceSeedDeps extends SeedOptions {
  credentials: CredentialStore;
  catalog: Map<string, CatalogListing>;
}

/** Write the workspace's connector rows, then the credential records that decide each one's state. */
async function seedWorkspacePlugins(
  store: WorkspaceStore,
  ws: Workspace,
  demo: DemoWorkspace,
  deps: WorkspaceSeedDeps,
): Promise<void> {
  const rows = demo.plugins.map((plugin) => workspaceRow(plugin, deps));
  const seeded = new Set(rows.map((r) => r.serverName));
  const oauthClients: Record<string, WorkspaceOAuthClient> = { ...ws.oauthClients };
  for (const plugin of demo.plugins) {
    if (plugin.state !== "needs-setup") continue;
    oauthClients[plugin.catalogId] ??= {
      clientId: `${slugifyServerName(plugin.catalogId)}-client`,
      configuredAt: SEEDED_AT,
      configuredBy: DEMO_USER_ID,
    };
  }
  await store.update(ws.id, {
    connectors: [...ws.connectors.filter((r) => !seeded.has(r.serverName)), ...rows],
    oauthClients,
  });

  for (const plugin of demo.plugins) {
    const owner = { type: "workspace", wsId: ws.id } as const;
    if (plugin.state === "ready" && plugin.account === "api-key") {
      await deps.credentials.put(
        { kind: "workspace", wsId: ws.id },
        apiKeyName(plugin.serverName),
        `demo-${plugin.serverName}-key`,
      );
    } else if (plugin.state === "ready") {
      await new McpOAuthRecords({ owner, serverName: plugin.serverName }).write(
        "identity",
        plugin.account,
      );
    } else if (plugin.state === "sign-in-expired") {
      // What the OAuth provider records when the vendor rejects a refresh: the
      // flag, and no tokens. Boot reads it as `reauth_required`.
      await setMcpOAuthAuthLost(owner, slugifyServerName(plugin.catalogId));
    }
    // `needs-setup` leaves the OAuth client secret out of the store, and
    // `needs-sign-in` writes no tokens: their absence is the state.
  }
}

function apiKeyName(serverName: string): string {
  return `${serverName}.api-key`;
}

/** The connector row the matching install path writes for `plugin`. */
function workspaceRow(plugin: WorkspacePlugin, deps: WorkspaceSeedDeps): ConnectorRef {
  if (plugin.state === "ready")
    return mockRow(plugin.serverName, plugin.account === "api-key", deps);
  if (plugin.state === "failed") {
    const url = {
      closed: deps.fleet.failing.closed,
      error: deps.fleet.failing.error,
      "wrong-path": deps.fleet.failing.wrongPath,
    }[plugin.failure];
    return {
      url,
      serverName: plugin.serverName,
      transport: { type: "streamable-http", auth: { type: "none" } },
      oauthScope: "workspace",
      display: { title: plugin.title },
    };
  }
  const entry = catalogEntry(deps.catalog, plugin.catalogId);
  const ref = catalogRow(entry);
  if (plugin.state === "needs-setup") {
    const setup =
      entry.install.kind === "remote-oauth" ? entry.install.oauthClientSetup : undefined;
    if (!setup) throw new Error(`[plugins-demo] ${plugin.catalogId} is not a static-auth entry`);
    ref.oauthClient = {
      clientId: `${slugifyServerName(plugin.catalogId)}-client`,
      clientSecret: { ref: "credential", key: setup.clientSecretKey },
    };
  }
  return { ...ref, oauthScope: "workspace" };
}

/** A mock server added by URL (`handleInstallDirectUrl`), or with an API key in place of no auth. */
function mockRow(serverName: string, apiKey: boolean, deps: WorkspaceSeedDeps): ConnectorRef {
  const mock = MOCK_SERVERS.find((m) => m.serverName === serverName);
  const url = deps.fleet.urls.get(serverName);
  if (!mock || !url) throw new Error(`[plugins-demo] no mock server named ${serverName}`);
  return {
    url,
    serverName,
    transport: {
      type: "streamable-http",
      auth: apiKey
        ? { type: "bearer", token: { ref: "credential", key: apiKeyName(serverName) } }
        : { type: "none" },
    },
    oauthScope: "workspace",
    ...(mock.app
      ? {
          ui: {
            placements: [
              {
                slot: "sidebar.apps",
                resourceUri: appResourceUri(mock),
                label: mock.app.label,
                route: mock.app.route,
              },
            ],
          },
        }
      : {}),
    display: { title: mock.title, description: mock.description },
  };
}

function catalogEntry(catalog: Map<string, CatalogListing>, id: string): CatalogListing {
  const entry = catalog.get(id);
  if (entry?.install.kind !== "remote-oauth") {
    throw new Error(`[plugins-demo] the demo catalog has no remote entry "${id}"`);
  }
  return entry;
}

/** A remote catalog entry's row with no workspace scope: the personal shape (`handleInstallIdentity`). */
function catalogRow(entry: CatalogListing): ConnectorRef {
  if (entry.install.kind !== "remote-oauth")
    throw new Error(`[plugins-demo] ${entry.id} is not remote`);
  return {
    url: entry.install.url,
    serverName: slugifyServerName(entry.id),
    transport: { type: entry.install.transportType },
  };
}

/** The dev user's personal plugins, their sign-ins, and their grants. */
async function seedPersonalPlugins(
  workDir: string,
  catalog: Map<string, CatalogListing>,
  workspaceIds: Map<string, string>,
): Promise<number> {
  const identity = new IdentityConnectorStore({ workDir });
  const permissions = new PermissionStore(workDir);
  const owner = { type: "user", userId: DEMO_USER_ID } as const;
  for (const plugin of PERSONAL_PLUGINS) {
    const ref = catalogRow(catalogEntry(catalog, plugin.catalogId));
    const serverName = ref.serverName;
    if (!(await identity.get(DEMO_USER_ID, serverName))) await identity.add(DEMO_USER_ID, ref);
    if (plugin.connected) {
      // A completed sign-in: the token pair and the account it named. The
      // tokens are placeholders, so using the plugin in chat fails at the
      // fictional host; the listing reads only their presence.
      const records = new McpOAuthRecords({ owner, serverName });
      if (!(await records.has("tokens"))) {
        await records.write("tokens", {
          access_token: `demo-${serverName}-token`,
          token_type: "Bearer",
          refresh_token: `demo-${serverName}-refresh`,
        });
      }
      await records.write("identity", plugin.account ?? { email: PERSONAL_ACCOUNT });
    }
    for (const name of plugin.grantedIn) {
      const wsId = workspaceIds.get(name);
      if (!wsId) throw new Error(`[plugins-demo] no demo workspace named ${name}`);
      await permissions.grantConnector(DEMO_USER_ID, serverName, wsId);
    }
  }
  return PERSONAL_PLUGINS.length;
}

/** Write each skill into `dir` unless one of that name is there. Returns how many the tier holds. */
function writeSkills(dir: string, skills: readonly SkillFixture[]): number {
  for (const s of skills) {
    if (readSkill(dir, s.name)) continue;
    writeSkill(
      dir,
      s.name,
      {
        name: s.name,
        description: s.description,
        loadingStrategy: s.loading,
        priority: s.priority ?? 50,
        status: s.disabled ? "disabled" : "active",
        ...(s.toolAffinity ? { toolAffinity: s.toolAffinity } : {}),
        ...(s.triggers ? { triggers: s.triggers } : {}),
        provenance: { origin: "admin", createdBy: DEMO_USER_ID, createdAt: SEEDED_AT },
      },
      `# ${s.description}\n\nDemo guidance for the plugins demo.`,
    );
  }
  return skills.length;
}

/**
 * One conversation whose tool calls name workspace plugins, a personal plugin,
 * and a skill a plugin publishes, so the chat's plugin labels show.
 */
async function seedConversation(workDir: string, wsId: string): Promise<void> {
  const store = new EventSourcedConversationStore({
    dir: workspaceConversationsDir(workDir, wsId, DEMO_USER_ID),
  });
  if (existsSync(join(store.getDir(), `${DEMO_CONVERSATION_ID}.jsonl`))) return;
  await store.create({
    id: DEMO_CONVERSATION_ID,
    ownerId: DEMO_USER_ID,
    model: MODEL,
    workspaceId: wsId,
  });

  const calls: { id: string; name: string; input: Record<string, unknown>; output: string }[] = [
    {
      id: "call_demo_1",
      name: "nb__use_skill",
      input: { name: "connector:helpdesk:triage-playbook" },
      output: "# Triage playbook\n\nUrgent first, then oldest. Billing goes to the billing group.",
    },
    {
      id: "call_demo_2",
      name: "helpdesk__list_tickets",
      input: { status: "open" },
      output: "3 open tickets: #4182 (urgent, billing), #4179 (shipping), #4175 (login)",
    },
    {
      id: "call_demo_3",
      name: "acme-crm__find_account",
      input: { query: "Globex" },
      output: "Globex Corporation, enterprise plan, renewal in 41 days",
    },
    {
      id: "call_demo_4",
      name: "my_com-google-calendar-mcp__list_events",
      input: { day: "today" },
      output: "10:00 Support standup; 14:30 Globex renewal check-in",
    },
  ];
  const at = (minute: number) => `2026-11-02T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const runId = "run_pluginsdemo01";
  const usage = { inputTokens: 1800, outputTokens: 120 };
  const events: ConversationEvent[] = [
    { ts: at(0), type: "metadata.title", title: "Triage the overnight queue" },
    {
      ts: at(0),
      type: "user.message",
      userId: DEMO_USER_ID,
      content: [
        { type: "text", text: "Triage the overnight queue and check my calendar for Globex." },
      ],
    },
    { ts: at(1), type: "run.start", runId, model: MODEL },
    {
      ts: at(1),
      type: "llm.response",
      runId,
      model: MODEL,
      content: calls.map((c) => ({
        type: "tool-call" as const,
        toolCallId: c.id,
        toolName: c.name,
        input: JSON.stringify(c.input),
      })),
      usage,
      llmMs: 900,
      finishReason: "tool-calls",
    },
    ...calls.flatMap((c): ConversationEvent[] => [
      { ts: at(2), type: "tool.start", runId, name: c.name, id: c.id },
      {
        ts: at(2),
        type: "tool.done",
        runId,
        name: c.name,
        id: c.id,
        ok: true,
        ms: 140,
        output: c.output,
      },
    ]),
    {
      ts: at(3),
      type: "llm.response",
      runId,
      model: MODEL,
      content: [
        {
          type: "text",
          text: "Three tickets are open overnight. #4182 is urgent billing for Globex, which renews in 41 days, so I'd take it first; you have a Globex check-in at 14:30.",
        },
      ],
      usage,
      llmMs: 1200,
      finishReason: "stop",
    },
    { ts: at(3), type: "run.done", runId, stopReason: "complete", totalMs: 2400 },
  ];
  for (const event of events) store.appendEvent(DEMO_CONVERSATION_ID, event);
  await store.flush();
}
