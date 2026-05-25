/**
 * Two-workspace fixture for the Stage 2 cross-workspace
 * contract.
 *
 * Boots a `Runtime` with two workspaces visible to a single identity:
 *   1. A shared workspace (default id `ws_helix`).
 *   2. The identity's personal workspace at `personalWorkspaceIdFor(userId)`.
 *
 * Each workspace gets its own in-process MCP source with a single counter-
 * incrementing echo tool. Tests can read the per-source counters to verify
 * dispatch topology (e.g. that a `ws_helix/...` tool call did NOT land in
 * the personal workspace's source).
 *
 * Reuse: T011's smoke variant imports this fixture to drive an external MCP
 * client end-to-end. Anything that bakes in test-only assumptions
 * (test-mode auth, in-memory stores, etc.) belongs in the test file, not
 * here. The fixture leans on the same public `Runtime.start()` /
 * `Runtime.ensureWorkspaceRegistry()` surface a production deploy uses.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { textContent } from "../../src/engine/content-helpers.ts";
import type { EventSink } from "../../src/engine/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { getRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ChatRequest } from "../../src/runtime/types.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { namespacedToolName } from "../../src/tools/namespace.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import {
  personalWorkspaceIdFor,
  type WorkspaceStore,
} from "../../src/workspace/workspace-store.ts";
import { createEchoModel, type EchoModelOptions } from "./echo-model.ts";

// ── Public option / handle shapes ──────────────────────────────────

/**
 * Options for `createTwoWorkspaceFixture`. All fields optional; defaults
 * are designed to mirror the load-bearing Stage 2 chat surface a single
 * user would actually see: one shared workspace + one personal workspace.
 */
export interface TwoWorkspaceFixtureOptions {
  /**
   * Identity that owns the personal workspace and authenticates chat
   * requests. Defaults to a neutral `user_a` placeholder so the fixture
   * is safe to import from OSS test files.
   */
  identity?: UserIdentity;
  /**
   * Shared workspace id. Defaults to `ws_helix`. Must be a valid `ws_*`
   * id; `WorkspaceStore.create` re-prefixes the slug.
   */
  sharedWorkspaceId?: string;
  /**
   * Display name for the shared workspace. Defaults to `"Helix"`.
   */
  sharedWorkspaceName?: string;
  /**
   * Pre-programmed echo model responses. When provided, the runtime is
   * configured with `createEchoModel({ responses })` so tests can script
   * tool calls. When omitted, the default echo model is used (text-only).
   */
  modelResponses?: EchoModelOptions["responses"];
  /**
   * Tool name (bare, without source prefix) registered in the shared
   * workspace's source. Defaults to `"search"`. Combined with the source
   * name `crm`, the namespaced canonical is `<sharedWorkspaceId>/crm__search`.
   */
  sharedToolName?: string;
  /**
   * Tool name (bare, without source prefix) registered in the personal
   * workspace's source. Defaults to `"send"`. Combined with the source
   * name `gmail`, the namespaced canonical is `<personalWorkspaceId>/gmail__send`.
   */
  personalToolName?: string;
}

/**
 * Per-workspace handle exposed by the fixture. The `name` /
 * `qualifiedToolName` fields are the load-bearing strings tests assert on:
 *
 *  - `qualifiedToolName` is the `ws_<id>-<source>__<tool>` form the
 *    orchestrator (post-T006) parses on every tool call.
 *  - `callCount()` is the topology probe — a non-zero counter on the
 *    *wrong* workspace would fail the "naive: dispatch to current
 *    workspace" failure mode (lesson 1).
 *  - `auditTrail()` is the attribution probe (Stage 1 lesson 2) — the
 *    sequence of `RequestContext.workspaceId` values that were active
 *    each time this source's handler ran. A correct orchestrator stamps
 *    the parsed-from-namespace workspace; the failure mode (stamping the
 *    session's default) is invisible to `callCount()` but a smoking gun
 *    here.
 */
export interface WorkspaceHandle {
  /** Canonical workspace id, e.g. `ws_helix` or `ws_user_<userId>`. */
  id: string;
  /** Human display name. */
  name: string;
  /** Source name registered into the workspace's `ToolRegistry`. */
  sourceName: string;
  /** Bare tool name (no source prefix). */
  toolName: string;
  /** Fully qualified namespaced name — what the model emits as `tool-call`. */
  qualifiedToolName: string;
  /** Returns the running counter of calls dispatched into THIS workspace's source. */
  callCount: () => number;
  /** Reset counter to zero. Useful when reusing a fixture across cases. */
  resetCallCount: () => void;
  /**
   * Workspace ids observed in `RequestContext.workspaceId` at handler-
   * invocation time, in call order. Independent observation channel
   * from `callCount()`: a misattribution that still routes to the right
   * source (e.g. session-default stamped onto a correctly-routed
   * dispatch) shows up here as a mismatched id while the counter looks
   * fine.
   */
  auditTrail: () => string[];
  /** Reset audit trail. */
  resetAuditTrail: () => void;
  /** The underlying source (in-process MCP), exposed for advanced assertions. */
  source: McpSource;
}

/**
 * Captured event emitted by the runtime during a chat. Tests filter by
 * `type === "tool.done"` and assert per-call attribution.
 *
 * The fixture deliberately stores events as `{type, data}` envelopes
 * (matching `EngineEvent`) rather than narrowing here — Stage 2's
 * orchestrator will add a `workspaceId` field to `tool.done.data`, and
 * the test that asserts that exact contract lives in the test file, not
 * this helper.
 */
export interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Returned by `createTwoWorkspaceFixture` — handle for tests + cleanup. */
export interface TwoWorkspaceFixture {
  /** Disk root for the runtime. Removed by `cleanup()`. */
  workDir: string;
  /** Started Runtime instance. */
  runtime: Runtime;
  /** Identity used for `chat({ identity, ... })` calls. */
  identity: UserIdentity;
  /** Shared workspace handle. */
  shared: WorkspaceHandle;
  /** Personal workspace handle (id from `personalWorkspaceIdFor(identity.id)`). */
  personal: WorkspaceHandle;
  /**
   * EventSink that captured every engine event emitted during the
   * fixture's lifetime. Tests pass `events` as the second arg to
   * `runtime.chat(request, events)` — or read `events.captured` for
   * assertions even without a per-request sink (the runtime's default
   * sink already forwards here).
   */
  events: {
    sink: EventSink;
    captured: CapturedEvent[];
    clear: () => void;
  };
  /**
   * Build a `ChatRequest` with the fixture's identity pre-populated.
   *
   * T006: the chat surface is identity-bound, so no `workspaceId` is
   * passed — the runtime aggregates tools across every workspace the
   * identity can see and routes each call via the orchestrator.
   */
  buildChatRequest: (overrides: Partial<ChatRequest> & { message: string }) => ChatRequest;
  /** Tear down: stop runtime, remove workDir. Always call in `afterAll`/`afterEach`. */
  cleanup: () => Promise<void>;
}

// ── Defaults ───────────────────────────────────────────────────────

/**
 * Neutral placeholder identity. No tenant- or person-specific information;
 * the fixture is reused in OSS-public tests and in T011's smoke variant.
 */
const DEFAULT_IDENTITY: UserIdentity = {
  id: "user_a",
  email: "user_a@example.test",
  displayName: "User A",
  orgRole: "member",
  preferences: {},
};

const DEFAULT_SHARED_WS_ID = "ws_helix";
const DEFAULT_SHARED_WS_NAME = "Helix";

const SHARED_SOURCE_NAME = "crm";
const PERSONAL_SOURCE_NAME = "gmail";

// ── Implementation ────────────────────────────────────────────────

/**
 * Build an in-process MCP source with a single counter-incrementing
 * echo tool. The handler closes over a local `count` variable so the
 * caller can read dispatch topology from the returned `callCount()` getter,
 * and an `audit` array so callers can read the per-call
 * `RequestContext.workspaceId` (Stage 1 lesson 2 — attribution proof
 * independent of the dispatch-topology counter).
 */
function buildCounterSource(
  sourceName: string,
  toolName: string,
  sink: EventSink,
): {
  source: McpSource;
  callCount: () => number;
  reset: () => void;
  audit: () => string[];
  resetAudit: () => void;
} {
  let count = 0;
  const audit: string[] = [];
  const tool: InProcessTool = {
    name: toolName,
    description: `Counter-echo tool exposed by source "${sourceName}".`,
    inputSchema: {
      type: "object",
      properties: {
        echo: {
          type: "string",
          description: "Text the handler will echo back.",
        },
      },
    },
    handler: async (input) => {
      count += 1;
      // The orchestrator wraps `source.execute` in `runWithRequestContext`
      // with `workspaceId` set to the parsed-from-namespace target. We
      // record what the handler saw — the audit channel external to
      // the counter. Sentinel string when context is absent so the
      // assertion failure mode is unmistakable ("no context" vs wrong id).
      const ctx = getRequestContext();
      audit.push(ctx?.workspaceId ?? "<no-request-context>");
      const echo = typeof input.echo === "string" ? input.echo : "";
      // The output text uniquely identifies the originating source so
      // tests can verify the two calls produced distinguishable strings
      // (happy-path "output strings differ" assertion).
      return {
        content: textContent(`[${sourceName}] call #${count}: ${echo}`),
        isError: false,
      };
    },
  };
  const source = defineInProcessApp(
    {
      name: sourceName,
      version: "1.0.0",
      tools: [tool],
    },
    sink,
  );
  return {
    source,
    callCount: () => count,
    reset: () => {
      count = 0;
    },
    audit: () => [...audit],
    resetAudit: () => {
      audit.length = 0;
    },
  };
}

/**
 * Provision the shared workspace and add `identity` as an admin member.
 * The shared workspace is created via the public `WorkspaceStore` API so
 * the fixture matches the production code path (membership + invariants).
 */
async function provisionSharedWorkspace(
  store: WorkspaceStore,
  wsId: string,
  name: string,
  userId: string,
): Promise<void> {
  if (!wsId.startsWith("ws_")) {
    throw new Error(
      `[two-workspace-fixture] shared workspace id must start with "ws_"; got "${wsId}"`,
    );
  }
  const slug = wsId.slice(3);
  const existing = await store.get(wsId);
  if (!existing) {
    await store.create(name, slug);
  }
  await store.addMember(wsId, userId, "admin");
}

/**
 * Create the two-workspace fixture and start the runtime.
 *
 * Side effects: makes a temp `workDir`, boots a `Runtime`, registers two
 * in-process sources. Call `cleanup()` in `afterAll`/`afterEach`.
 */
export async function createTwoWorkspaceFixture(
  options: TwoWorkspaceFixtureOptions = {},
): Promise<TwoWorkspaceFixture> {
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const sharedWorkspaceId = options.sharedWorkspaceId ?? DEFAULT_SHARED_WS_ID;
  const sharedWorkspaceName = options.sharedWorkspaceName ?? DEFAULT_SHARED_WS_NAME;
  const sharedToolBareName = options.sharedToolName ?? "search";
  const personalToolBareName = options.personalToolName ?? "send";

  const workDir = join(
    tmpdir(),
    `nb-two-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });

  // Capture events emitted during the fixture's lifetime. The runtime
  // attaches its default sinks (log-sink, etc.) on top of any user
  // sinks; we pass ours through `events: [sink]` so every engine
  // event lands in `captured`.
  const captured: CapturedEvent[] = [];
  const sink: EventSink = {
    emit(event) {
      captured.push({ type: event.type, data: { ...event.data } });
    },
  };

  // Build the model. When `modelResponses` is provided, the model is
  // scripted to emit those responses in order (FIFO); otherwise the
  // model echoes the last user message — useful for fixture smoke checks.
  const model = createEchoModel(
    options.modelResponses ? { responses: options.modelResponses } : undefined,
  );

  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: model },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
    events: [sink],
  });

  // Provision both workspaces. The personal workspace goes through the
  // same `ensureUserWorkspace` helper production uses on first login —
  // exercises the real `personalWorkspaceIdFor(...)` + invariant path.
  const wsStore = runtime.getWorkspaceStore();
  await provisionSharedWorkspace(wsStore, sharedWorkspaceId, sharedWorkspaceName, identity.id);
  await ensureUserWorkspace(wsStore, { id: identity.id, displayName: identity.displayName });

  const personalWorkspaceId = personalWorkspaceIdFor(identity.id);

  // Ensure per-workspace tool registries exist BEFORE adding sources.
  // `ensureWorkspaceRegistry` is the same JIT path runtime.chat takes
  // for workspaces created after boot.
  const sharedRegistry = await runtime.ensureWorkspaceRegistry(sharedWorkspaceId);
  const personalRegistry = await runtime.ensureWorkspaceRegistry(personalWorkspaceId);

  // Build per-workspace sources. Each closes over its own counter — the
  // topology assertion in the test reads these to verify a `ws_helix/...`
  // call did NOT land in the personal workspace's source.
  const sharedSource = buildCounterSource(SHARED_SOURCE_NAME, sharedToolBareName, sink);
  const personalSource = buildCounterSource(PERSONAL_SOURCE_NAME, personalToolBareName, sink);
  await sharedSource.source.start();
  await personalSource.source.start();

  sharedRegistry.addSource(sharedSource.source);
  personalRegistry.addSource(personalSource.source);

  // T006 fixture reconciliation: post-orchestrator, the fixture's qualified
  // names route through `routeToolCall` and must match the orchestrator's
  // parse contract exactly. Build them via the single legal construction
  // site (`namespacedToolName`) so any future tweak to the primitive
  // surfaces here as a build error instead of as a silent dispatch miss.
  // The inner part stays `<source>__<tool>` because that's what the
  // workspace's `ToolRegistry` expects after the orchestrator strips
  // the `ws_<id>/` prefix.
  const sharedHandle: WorkspaceHandle = {
    id: sharedWorkspaceId,
    name: sharedWorkspaceName,
    sourceName: SHARED_SOURCE_NAME,
    toolName: sharedToolBareName,
    qualifiedToolName: namespacedToolName(
      sharedWorkspaceId,
      `${SHARED_SOURCE_NAME}__${sharedToolBareName}`,
    ),
    callCount: sharedSource.callCount,
    resetCallCount: sharedSource.reset,
    auditTrail: sharedSource.audit,
    resetAuditTrail: sharedSource.resetAudit,
    source: sharedSource.source,
  };
  const personalHandle: WorkspaceHandle = {
    id: personalWorkspaceId,
    name: `${identity.displayName}'s Workspace`,
    sourceName: PERSONAL_SOURCE_NAME,
    toolName: personalToolBareName,
    qualifiedToolName: namespacedToolName(
      personalWorkspaceId,
      `${PERSONAL_SOURCE_NAME}__${personalToolBareName}`,
    ),
    callCount: personalSource.callCount,
    resetCallCount: personalSource.reset,
    auditTrail: personalSource.audit,
    resetAuditTrail: personalSource.resetAudit,
    source: personalSource.source,
  };

  // T006: `ChatRequest.workspaceId` is removed. The chat surface is
  // identity-bound — tools come from every workspace the identity can
  // see and each call routes by namespace prefix. The fixture's
  // `buildChatRequest` reflects that by only stamping `identity`.
  const buildChatRequest: TwoWorkspaceFixture["buildChatRequest"] = (overrides) => ({
    identity,
    ...overrides,
  });

  const cleanup = async (): Promise<void> => {
    try {
      await runtime.shutdown();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  return {
    workDir,
    runtime,
    identity,
    shared: sharedHandle,
    personal: personalHandle,
    events: {
      sink,
      captured,
      clear: () => {
        captured.length = 0;
      },
    },
    buildChatRequest,
    cleanup,
  };
}
