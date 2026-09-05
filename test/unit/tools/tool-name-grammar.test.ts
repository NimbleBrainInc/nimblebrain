/**
 * The `<source>__<tool>` grammar, and the doors' agreement on it.
 *
 * Every dispatch door has to take a wire tool name apart the same way, or two
 * doors answer the same question differently and the divergence is a misroute
 * rather than a wrong label. `src/util/tool-name.ts` is the one decomposition;
 * this suite pins its contract and then pins that the two doors reachable
 * without a server — `ToolRegistry.execute` (the REST registry dispatch) and
 * `routeToolCall` via `IdentityToolRouter` (chat / `/mcp`) — resolve
 * the same source and dispatch the same bare name for the same input.
 *
 * The `/mcp` and REST HTTP handlers read the same primitive; they are covered at
 * the integration tier, not here.
 *
 * **Why `hasSeparator` is asserted separately.** A door must not infer "this
 * name has no source segment" by comparing the two segments: `x__x` has equal
 * segments AND a separator, while `plain` has equal segments and none. Both are
 * in the table so a door that reintroduces the comparison — or any other
 * home-grown sentinel for absence — fails here rather than in production, where
 * it is a misroute.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { textContent } from "../../../src/engine/content-helpers.ts";
import type { ToolResult, ToolSchema } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import type { OrchestratorRuntime } from "../../../src/orchestrator/index.ts";
import { PermissionStore } from "../../../src/permissions/permission-store.ts";
import { IdentityToolRouter } from "../../../src/runtime/identity-tool-router.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { splitInnerToolName } from "../../../src/util/tool-name.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

// ── The grammar table ─────────────────────────────────────────────

interface GrammarCase {
  /** The wire name a door receives. */
  wire: string;
  /** The registry key the door must look the source up under. */
  sourcePrefix: string;
  /** The bare name the door must hand `ToolSource.execute`. */
  bareToolName: string;
  hasSeparator: boolean;
  why: string;
}

const GRAMMAR: GrammarCase[] = [
  {
    wire: "crm__search",
    sourcePrefix: "crm",
    bareToolName: "search",
    hasSeparator: true,
    why: "the ordinary shape",
  },
  {
    wire: "synapse-todo-board__create_board_task",
    sourcePrefix: "synapse-todo-board",
    bareToolName: "create_board_task",
    hasSeparator: true,
    why: "a source segment may contain `-` (slugifyServerName emits [a-z0-9-])",
  },
  {
    wire: "my_gmail__send",
    sourcePrefix: "my_gmail",
    bareToolName: "send",
    hasSeparator: true,
    why: "the personal-connector marker rides in the source segment, single `_`",
  },
  {
    wire: "crm__a__b",
    sourcePrefix: "crm",
    bareToolName: "a__b",
    hasSeparator: true,
    why: "split on the FIRST separator — a tool segment may contain `__`",
  },
  {
    wire: "x__x",
    sourcePrefix: "x",
    bareToolName: "x",
    hasSeparator: true,
    why: "equal segments WITH a separator — absence must not be inferred by comparison",
  },
  {
    wire: "trailing__",
    sourcePrefix: "trailing",
    bareToolName: "",
    hasSeparator: true,
    why: "an empty tool segment is a resolvable source with an unresolvable tool",
  },
  {
    wire: "__leading",
    sourcePrefix: "",
    bareToolName: "leading",
    hasSeparator: true,
    why: "an empty source segment is a separator present, not absent",
  },
  {
    wire: "plain",
    sourcePrefix: "plain",
    bareToolName: "plain",
    hasSeparator: false,
    why: "no separator — both segments are the whole name, and the flag says so",
  },
];

/**
 * Rows a WORKSPACE door can dispatch: a separator, a non-empty source key, and
 * not the personal-connector marker (which takes the identity door and is
 * covered on its own below).
 */
const DISPATCHABLE = GRAMMAR.filter(
  (c) => c.hasSeparator && c.sourcePrefix.length > 0 && !c.sourcePrefix.startsWith("my_"),
);

// ── Stubs ─────────────────────────────────────────────────────────

interface RecordingSource extends ToolSource {
  /** Bare tool names observed at `execute(...)`. */
  executed: string[];
}

function makeRecordingSource(name: string): RecordingSource {
  const executed: string[] = [];
  return {
    name,
    executed,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(toolName: string): Promise<ToolResult> {
      executed.push(toolName);
      return { content: textContent("ok"), isError: false };
    },
  };
}

const WS_ID = "ws_helix";
const USER_ID = "u1";

/**
 * The narrow `OrchestratorRuntime` `routeToolCall` needs, recording every source
 * name the workspace registry is asked for. That record is how a change to the
 * orchestrator's own decomposition becomes visible: it is the name the door
 * derived, before any source exists to confirm or deny it.
 */
function makeStubRuntime(
  workDir: string,
  sources: ToolSource[],
  lookups: string[],
): OrchestratorRuntime {
  return {
    getWorkspaceContext(wsId: string) {
      return new WorkspaceContext({ wsId, workDir });
    },
    getRegistryForWorkspace() {
      return {
        getSource(name: string): ToolSource | undefined {
          lookups.push(name);
          return sources.find((s) => s.name === name);
        },
      };
    },
    getIdentitySource(): ToolSource | undefined {
      return undefined;
    },
    getIdentityContext(identityId: string): IdentityContext {
      return new IdentityContext({ userId: identityId, workDir });
    },
    async listToolsForWorkspace(): Promise<ToolSchema[]> {
      return [];
    },
  };
}

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-tool-name-grammar-"));
});
afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ── The primitive ─────────────────────────────────────────────────

describe("splitInnerToolName", () => {
  for (const c of GRAMMAR) {
    test(`${JSON.stringify(c.wire)} — ${c.why}`, () => {
      expect(splitInnerToolName(c.wire)).toEqual({
        sourcePrefix: c.sourcePrefix,
        bareToolName: c.bareToolName,
        hasSeparator: c.hasSeparator,
      });
    });
  }
});

// ── Door 1: ToolRegistry.execute ──────────────────────────────────

describe("ToolRegistry.execute agrees with the grammar", () => {
  for (const c of DISPATCHABLE) {
    test(`routes ${JSON.stringify(c.wire)} to "${c.sourcePrefix}" as "${c.bareToolName}"`, async () => {
      const registry = new ToolRegistry();
      const source = makeRecordingSource(c.sourcePrefix);
      registry.addSource(source);

      const result = await registry.execute({ id: "t1", name: c.wire, input: {} });

      expect(result.isError).toBe(false);
      expect(source.executed).toEqual([c.bareToolName]);
    });
  }

  test("a name with no separator is an invalid-name error, not a dispatch", async () => {
    // `plain` and the registered source `plain` share a string. A door that
    // inferred absence by comparing segments would find the source and dispatch
    // `plain__plain`'s tool — this asserts it takes the recovery path instead.
    const registry = new ToolRegistry();
    const source = makeRecordingSource("plain");
    registry.addSource(source);

    const result = await registry.execute({ id: "t1", name: "plain", input: {} });

    expect(result.isError).toBe(true);
    expect(source.executed).toEqual([]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Invalid tool name");
  });

  test("an empty source segment resolves no source", async () => {
    const registry = new ToolRegistry();
    registry.addSource(makeRecordingSource("leading"));

    const result = await registry.execute({ id: "t1", name: "__leading", input: {} });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Unknown source");
  });
});

// ── Door 2: routeToolCall via IdentityToolRouter ──────────────────

describe("the orchestrator door agrees with the grammar", () => {
  for (const c of DISPATCHABLE) {
    test(`routes ${JSON.stringify(c.wire)} to "${c.sourcePrefix}" as "${c.bareToolName}"`, async () => {
      const source = makeRecordingSource(c.sourcePrefix);
      const lookups: string[] = [];
      const router = new IdentityToolRouter({
        identityId: USER_ID,
        workspaceId: WS_ID,
        runtime: makeStubRuntime(workDir, [source], lookups),
      });

      const result = await router.execute({ id: "t1", name: c.wire, input: {} });

      expect(result.isError).toBe(false);
      expect(lookups).toEqual([c.sourcePrefix]);
      expect(source.executed).toEqual([c.bareToolName]);
    });
  }

  test("a name with no separator names no source and never dispatches", async () => {
    // Same trap as the registry case: `plain` is a registered source name.
    const source = makeRecordingSource("plain");
    const lookups: string[] = [];
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      workspaceId: WS_ID,
      runtime: makeStubRuntime(workDir, [source], lookups),
    });

    const result = await router.execute({ id: "t1", name: "plain", input: {} });

    expect(result.isError).toBe(true);
    expect(source.executed).toEqual([]);
    expect(result.structuredContent).toMatchObject({ reason: "unknown_tool_source" });
  });

  test("an empty source segment is unroutable", async () => {
    const lookups: string[] = [];
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      workspaceId: WS_ID,
      runtime: makeStubRuntime(workDir, [makeRecordingSource("leading")], lookups),
    });

    const result = await router.execute({ id: "t1", name: "__leading", input: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "unknown_tool_source",
      sourceName: "",
    });
  });

  test("the personal-connector marker is stripped from the source segment only", async () => {
    // The wire name carries `my_`; the connector's own `serverName` does not.
    // The door must resolve `gmail`, dispatch `send`, and leave the tool segment
    // untouched — a decomposition that stripped the marker from the whole name
    // first would look up `gmail` and dispatch `send` too, so the discriminating
    // assertion is the lookup ARGUMENT, which is the connector name and not the
    // wire name.
    const source = makeRecordingSource("gmail");
    const permissionStore = new PermissionStore(workDir);
    await permissionStore.grantConnector(USER_ID, "gmail", WS_ID);
    const resolved: string[] = [];
    const runtime: OrchestratorRuntime = {
      ...makeStubRuntime(workDir, [], []),
      getPermissionStore: () => permissionStore,
      async getIdentityConnectorSource(_userId: string, name: string) {
        resolved.push(name);
        return name === "gmail" ? source : undefined;
      },
    };
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      workspaceId: WS_ID,
      runtime,
    });

    const result = await router.execute({ id: "t1", name: "my_gmail__send", input: {} });

    expect(result.isError).toBe(false);
    expect(resolved).toEqual(["gmail"]);
    expect(source.executed).toEqual(["send"]);
  });

  // A usable tool segment is a separator AND a non-empty remainder, and the
  // marker has both shapes that fail it. `hasSeparator` alone answers only the
  // first: `my_granola__` has a separator and no tool. Either one, waved
  // through, strips to `granola`, resolves the caller's own connector, starts
  // it, and dispatches a synthesized `granola__` with an empty tool name — so
  // both are named here rather than one standing in for the pair.
  for (const wire of ["my_granola", "my_granola__"]) {
    test(`${JSON.stringify(wire)} — the marker with no tool segment is refused, not synthesized`, async () => {
      const source = makeRecordingSource("granola");
      const resolved: string[] = [];
      const runtime: OrchestratorRuntime = {
        ...makeStubRuntime(workDir, [], []),
        getPermissionStore: () => new PermissionStore(workDir),
        async getIdentityConnectorSource(_userId: string, name: string) {
          resolved.push(name);
          return source;
        },
      };
      const router = new IdentityToolRouter({
        identityId: USER_ID,
        workspaceId: WS_ID,
        runtime,
      });

      const result = await router.execute({ id: "t1", name: wire, input: {} });

      expect(result.isError).toBe(true);
      // The connector is never even resolved — refusal happens on the name,
      // before anything of the caller's is started.
      expect(resolved).toEqual([]);
      expect(source.executed).toEqual([]);
      expect(result.structuredContent).toMatchObject({ reason: "unknown_identity_source" });
    });
  }
});
