/**
 * Unit tests for `src/orchestrator/unattended-dispatch.ts` — the third door.
 *
 * Every case below names something a naive implementation gets wrong, and the
 * negative cases come first because they are the point: this door exists to
 * apply, without a session, the gates a session gets for free. A test that only
 * proved a tool call works would pass against an implementation with no gates
 * at all.
 *
 * Stubs are the ones `identity-tool-router.test.ts` uses (a registry map, spy
 * sources, a real `WorkspaceContext` over a temp dir), plus a real
 * `PermissionStore` — the grant and the per-tool `disallow` are exactly what is
 * under test, so a stub that answers them would test itself.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EngineEvent, EventSink, ToolResult } from "../../../src/engine/types.ts";
import { INTERNAL_TOOL_ANNOTATION } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import type { UnattendedDispatchRuntime } from "../../../src/orchestrator/unattended-dispatch.ts";
import { dispatchUnattended } from "../../../src/orchestrator/unattended-dispatch.ts";
import { PermissionStore } from "../../../src/permissions/permission-store.ts";
import { getRequestContext, type RequestContext } from "../../../src/runtime/request-context.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

// ── Stubs ─────────────────────────────────────────────────────────

interface SpyCall {
  toolName: string;
  input: Record<string, unknown>;
  /** RequestContext observed at dispatch time, from AsyncLocalStorage. */
  context: RequestContext | undefined;
}

interface SpySource extends ToolSource {
  calls: SpyCall[];
}

function makeSpySource(
  name: string,
  opts: {
    result?: ToolResult;
    /** Never settles — for the timeout case. */
    hang?: boolean;
    throws?: string;
    tools?: Tool[];
  } = {},
): SpySource {
  const calls: SpyCall[] = [];
  return {
    name,
    calls,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return opts.tools ?? [];
    },
    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
      calls.push({ toolName, input, context: getRequestContext() });
      if (opts.hang) return new Promise<ToolResult>(() => {});
      if (opts.throws) throw new Error(opts.throws);
      return opts.result ?? { content: [{ type: "text", text: `[${name}] ok` }], isError: false };
    },
  };
}

interface StubOpts {
  workDir: string;
  members?: string[];
  registries?: Map<string, ToolSource[]>;
  identitySources?: Map<string, ToolSource>;
  identityConnectors?: Map<string, ToolSource>;
  permissions?: PermissionStore;
  /** Every workspace whose registry was asked for, in order. */
  registryLookups?: string[];
  events?: EngineEvent[];
  /** Sink that fails to write — for the audit-emit guard. */
  sinkThrows?: boolean;
}

function makeStubRuntime(opts: StubOpts): UnattendedDispatchRuntime {
  const sink: EventSink = {
    emit(event: EngineEvent): void {
      if (opts.sinkThrows) throw new Error("workspace log is unwritable");
      opts.events?.push(event);
    },
  };
  return {
    async isPrincipalWorkspaceMember(_wsId: string, principalId: string): Promise<boolean> {
      return (opts.members ?? []).includes(principalId);
    },
    getEventSink(): EventSink {
      return sink;
    },
    getWorkspaceContext(wsId: string): WorkspaceContext {
      return new WorkspaceContext({ wsId, workDir: opts.workDir });
    },
    getRegistryForWorkspace(wsId: string) {
      opts.registryLookups?.push(wsId);
      const sources = opts.registries?.get(wsId) ?? [];
      return { getSource: (name: string) => sources.find((s) => s.name === name) };
    },
    getIdentitySource(name: string): ToolSource | undefined {
      return opts.identitySources?.get(name);
    },
    async getIdentityConnectorSource(_userId: string, name: string): Promise<ToolSource | undefined> {
      return opts.identityConnectors?.get(name);
    },
    getIdentityContext(identityId: string): IdentityContext {
      return new IdentityContext({ userId: identityId, workDir: opts.workDir });
    },
    ...(opts.permissions ? { getPermissionStore: () => opts.permissions } : {}),
    async listToolsForWorkspace() {
      return [];
    },
  } as UnattendedDispatchRuntime;
}

// ── Scaffolding ───────────────────────────────────────────────────

const WS = "ws_helix";
const PRINCIPAL = "usr_route_author";
const REASON = "route:rt_outbound_slack";

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-unattended-dispatch-"));
});
afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function call(runtime: UnattendedDispatchRuntime, tool: string, extra: Record<string, unknown> = {}) {
  return dispatchUnattended(runtime, {
    principalId: PRINCIPAL,
    workspaceId: WS,
    tool,
    input: {},
    reason: REASON,
    ...extra,
  });
}

// ── Negative cases ────────────────────────────────────────────────

describe("dispatchUnattended — membership", () => {
  // Pins ADR-0007's classification: a principal who left the workspace is
  // SKIPPED, not denied, so the configuration that named them stays intact and
  // self-heals on re-add. Naive failure: let the call through to the registry
  // and rely on the tool's own authz, which would keep an offboarded member
  // acting in a workspace they left.
  test("skips a non-member without touching the registry", async () => {
    const registryLookups: string[] = [];
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [], // the principal is not one
      registries: new Map([[WS, [crm]]]),
      registryLookups,
    });

    const res = await call(runtime, "crm__search");

    expect(res.outcome).toBe("skipped");
    expect(res.classification).toBe("owner_not_member");
    expect(registryLookups).toEqual([]);
    expect(crm.calls).toHaveLength(0);
  });
});

describe("dispatchUnattended — the unattended subtraction", () => {
  // Pins that the authoring surfaces are refused BY NAME, before routing. A
  // scheduled run gets this from surfacing (the tool is never shown); a single
  // dispatch has no listing to inherit it from, so the door has to say it.
  test("denies automations__create, and it never reaches the source", async () => {
    const automations = makeSpySource("automations");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      identitySources: new Map([["automations", automations]]),
    });

    const res = await call(runtime, "automations__create");

    expect(res.outcome).toBe("denied");
    expect(res.classification).toBe("tool_not_allowed");
    expect(automations.calls).toHaveLength(0);
  });

  // The read half of the same namespace stays reachable — the policy is an
  // allowlist over authoring, not a ban on the namespace.
  test("allows automations__list, which is on the task-safe allowlist", async () => {
    const automations = makeSpySource("automations");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      identitySources: new Map([["automations", automations]]),
    });

    const res = await call(runtime, "automations__list");

    expect(res.outcome).toBe("ok");
    expect(automations.calls).toHaveLength(1);
  });

  // The skills half of the same allowlist. A skill is durable guidance that
  // loads itself into the principal's later sessions, so authoring one grows
  // exactly the capability the policy refuses to let a dispatch acquire.
  test("denies skills__create but allows skills__read", async () => {
    const skills = makeSpySource("skills");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [skills]]]),
    });

    const denied = await call(runtime, "skills__create");
    expect(denied.outcome).toBe("denied");
    expect(denied.classification).toBe("tool_not_allowed");

    const allowed = await call(runtime, "skills__read");
    expect(allowed.outcome).toBe("ok");
    expect(skills.calls.map((c) => c.toolName)).toEqual(["read"]);
  });

  test("denies nb__manage_connectors", async () => {
    const nb = makeSpySource("nb");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [nb]]]),
    });

    const res = await call(runtime, "nb__manage_connectors");

    expect(res.outcome).toBe("denied");
    expect(res.classification).toBe("tool_not_allowed");
    expect(nb.calls).toHaveLength(0);
  });
});

describe("dispatchUnattended — the wall", () => {
  // A name addressing another workspace is not routed at all: the `ws_<id>-`
  // form is retired, so cross-workspace reach is unexpressible rather than
  // denied after resolution (ADR-0005).
  test("denies a retired ws_<id>- name by shape", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await call(runtime, "ws_0123456789abcdef-crm__search");

    expect(res.outcome).toBe("denied");
    expect(res.classification).toBe("invalid_tool_name");
    expect(crm.calls).toHaveLength(0);
  });

  // A source that is not in this workspace is an ERROR, not a denial: the same
  // condition also means "installed but transiently absent", and a caller with
  // a retry budget should be allowed to spend it.
  test("reports an unregistered source as an error, not a denial", async () => {
    const runtime = makeStubRuntime({ workDir, members: [PRINCIPAL], registries: new Map() });

    const res = await call(runtime, "crm__search");

    expect(res.outcome).toBe("error");
    expect(res.classification).toBe("unknown_tool_source");
  });
});

describe("dispatchUnattended — connector gates", () => {
  // ADR-0006: a personal connector runs in a shared workspace only with its
  // owner's grant. The door must not exempt itself because "the runtime is
  // calling" — the principal here is a person, and it is their grant.
  test("denies a my_ tool with no grant to this workspace", async () => {
    const gmail = makeSpySource("gmail");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      identityConnectors: new Map([["gmail", gmail]]),
      permissions: new PermissionStore(workDir),
    });

    const res = await call(runtime, "my_gmail__send");

    expect(res.outcome).toBe("denied");
    expect(res.classification).toBe("connector_grant_denied");
    expect(gmail.calls).toHaveLength(0);
  });

  test("allows the same my_ tool once the owner has granted it here", async () => {
    const permissions = new PermissionStore(workDir);
    await permissions.grantConnector(PRINCIPAL, "gmail", WS);
    const gmail = makeSpySource("gmail");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      identityConnectors: new Map([["gmail", gmail]]),
      permissions,
    });

    const res = await call(runtime, "my_gmail__send");

    expect(res.outcome).toBe("ok");
    // The marker is stripped at the door: the connector sees its own bare name.
    expect(gmail.calls[0]?.toolName).toBe("send");
  });

  // `assertToolAllowed` is the same check every other door runs. A tool an
  // operator disabled must stay disabled for a call nobody is watching.
  test("denies a tool the workspace's permission policy disallows", async () => {
    const permissions = new PermissionStore(workDir);
    await permissions.setConnector({ scope: "workspace", wsId: WS }, "crm", {
      search: "disallow",
    });
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
      permissions,
    });

    const res = await call(runtime, "crm__search");

    expect(res.outcome).toBe("denied");
    expect(res.classification).toBe("tool_permission_denied");
    expect(crm.calls).toHaveLength(0);
  });
});

describe("dispatchUnattended — bounds", () => {
  test("times out a source that never answers, and reports it as an error", async () => {
    const crm = makeSpySource("crm", { hang: true });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await call(runtime, "crm__search", { timeoutMs: 25 });

    expect(res.outcome).toBe("error");
    expect(res.classification).toBe("timeout");
    expect(res.result).toBeUndefined();
  });

  // The result is dropped, not truncated: half a JSON document is worse than
  // none, and the caller must never hold more than it agreed to hold.
  test("refuses a result over the size cap and returns none of it", async () => {
    const crm = makeSpySource("crm", {
      result: { content: [{ type: "text", text: "x".repeat(5_000) }], isError: false },
    });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await call(runtime, "crm__search", { maxResultBytes: 1_000 });

    expect(res.outcome).toBe("error");
    expect(res.classification).toBe("result_too_large");
    expect(res.result).toBeUndefined();
  });

  // The caller is a background sweep with nobody to show an exception to.
  test("returns an outcome when the tool throws, rather than throwing out", async () => {
    const crm = makeSpySource("crm", { throws: "upstream exploded" });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await call(runtime, "crm__search");

    expect(res.outcome).toBe("error");
    expect(res.classification).toBe("tool_error");
    expect(res.error).toContain("upstream exploded");
  });

  // The other half of the same contract, and the one a caller can trip without
  // any tool being involved: `IdentityToolRouter` validates its own arguments
  // and throws. Construction is inside the dispatch's `try` so that throw
  // becomes an outcome, and the source is never reached.
  test("returns an outcome when the router rejects its own arguments", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [""],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await dispatchUnattended(runtime, {
      principalId: "",
      workspaceId: WS,
      tool: "crm__search",
      input: {},
      reason: REASON,
    });

    expect(res.outcome).toBe("error");
    expect(res.classification).toBe("tool_error");
    expect(res.error).toContain("identityId");
    expect(crm.calls).toHaveLength(0);
  });
});

// ── The positive case, and what rides with it ─────────────────────

describe("dispatchUnattended — a call that goes through", () => {
  test("dispatches the bare tool name and returns the result", async () => {
    const crm = makeSpySource("crm", {
      result: { content: [{ type: "text", text: "found 3" }], isError: false },
    });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    const res = await dispatchUnattended(runtime, {
      principalId: PRINCIPAL,
      workspaceId: WS,
      tool: "crm__search",
      input: { q: "acme" },
      reason: REASON,
    });

    expect(res.outcome).toBe("ok");
    expect(res.classification).toBeUndefined();
    expect(res.result?.content).toEqual([{ type: "text", text: "found 3" }]);
    expect(crm.calls[0]?.toolName).toBe("search");
    expect(crm.calls[0]?.input).toEqual({ q: "acme" });
  });

  // `unattended` is what bars the authoring surface at the sources themselves,
  // below anything this door checks by name; `unattendedReason` is what the
  // outbound `_meta` stamp reads. Both must survive the router's per-call
  // context rebuild, which is an allowlist — a field not named there vanishes.
  test("the dispatched tool sees unattended and the reason in its request context", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
    });

    await call(runtime, "crm__search");

    expect(crm.calls[0]?.context?.unattended).toBe(true);
    expect(crm.calls[0]?.context?.unattendedReason).toBe(REASON);
    expect(crm.calls[0]?.context?.workspaceId).toBe(WS);
    expect(crm.calls[0]?.context?.identity?.id).toBe(PRINCIPAL);
  });

  // The annotation hides a tool from every listing; it has never made one
  // uncallable, and this door does not change that. Only the unattended policy
  // decides what may be named.
  test("an internal-annotated tool is still callable by name", async () => {
    const hooks = makeSpySource("hooks", {
      tools: [
        {
          name: "hooks__list_webhooks",
          description: "",
          inputSchema: { type: "object", properties: {} },
          source: "test",
          meta: { [INTERNAL_TOOL_ANNOTATION]: true },
        },
      ],
    });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [hooks]]]),
    });

    const res = await call(runtime, "hooks__list_webhooks");

    expect(res.outcome).toBe("ok");
    expect(hooks.calls).toHaveLength(1);
  });
});

// ── Audit ─────────────────────────────────────────────────────────

describe("dispatchUnattended — audit", () => {
  test("emits one audit line carrying the principal, workspace, tool and reason", async () => {
    const events: EngineEvent[] = [];
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
      events,
    });

    await call(runtime, "crm__search");

    const audits = events.filter((e) => e.type === "audit.unattended_dispatch");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.data).toMatchObject({
      principalId: PRINCIPAL,
      workspaceId: WS,
      tool: "crm__search",
      reason: REASON,
      outcome: "ok",
    });
  });

  // The line is the ONLY trace a dispatch leaves — no conversation, no run
  // result — so a refusal that never reached a tool has to be on it too.
  test("audits a refusal that never reached the registry", async () => {
    const events: EngineEvent[] = [];
    const runtime = makeStubRuntime({ workDir, members: [], events });

    await call(runtime, "crm__search");

    const audits = events.filter((e) => e.type === "audit.unattended_dispatch");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.data).toMatchObject({
      outcome: "skipped",
      classification: "owner_not_member",
      reason: REASON,
    });
  });

  test("truncates an over-long reason rather than writing it whole", async () => {
    const events: EngineEvent[] = [];
    const runtime = makeStubRuntime({ workDir, members: [], events });

    await call(runtime, "crm__search", { reason: "r".repeat(1_000) });

    expect(String(events[0]?.data.reason).length).toBe(200);
  });

  // `MultiEventSink` fans out to its sinks without a per-sink guard, so a sink
  // that cannot write would otherwise leave the dispatch by the one path it
  // promises never to take. The audit line is lost; the sweep is not, and the
  // call it was auditing still returns its result.
  test("returns the call's outcome even when the sink cannot write the line", async () => {
    const crm = makeSpySource("crm", {
      result: { content: [{ type: "text", text: "found 3" }], isError: false },
    });
    const runtime = makeStubRuntime({
      workDir,
      members: [PRINCIPAL],
      registries: new Map([[WS, [crm]]]),
      sinkThrows: true,
    });

    const res = await call(runtime, "crm__search");

    expect(res.outcome).toBe("ok");
    expect(res.result?.content).toEqual([{ type: "text", text: "found 3" }]);
    expect(crm.calls).toHaveLength(1);
  });
});
