/**
 * The built-in conversations app serves the public tools of the conversations
 * contract (`contracts/conversations/`) at a runtime's `/mcp/<wsId>` door, and
 * no private tool is reachable there.
 *
 * Boots a runtime, seeds one conversation through a chat turn, and runs the
 * contract's black-box conformance runner against `/mcp/<wsId>` in its
 * public-only mode, the check for a host's agent-facing surface. The door fixes
 * one scope and the `person` principal per connection (the workspace in its URL
 * and the signed-in identity), so the runner's carriage is `none`, and the cases
 * that need to state a second scope skip; the door's own wall is covered by
 * `mcp-server-identity-bound.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaseResult,
  runConformance,
} from "../../contracts/conversations/runner/conformance.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { MCP_PROTOCOL_VERSION } from "../helpers/mcp-client.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-conversations-contract-${Date.now()}`);
const FIXTURE_TEXT = "otters";

/**
 * Public cases today's door fails for a reason in the door, not in the case, each
 * with the text its failure carries.
 *
 * - The app lists `ui://conversations/browser`, but the door's unscoped
 *   `resources/list` enumerates only the workspace registry's sources, and the
 *   conversations app is an identity source outside it. The door reads the
 *   resource (identity sources are tried first on `resources/read`) and lists it
 *   when the request's `_meta` names the conversations source, but a plain
 *   listing omits it.
 * - Today's app throws plain errors, so its public errors carry the contract's
 *   message prefixes but no `code`. A conversations plugin emits both.
 */
const KNOWN_DIFFERENCES: Record<string, string> = {
  "lists ui://conversations/browser as an MCP App": "not listed",
  "public errors carry their code": "get code",
};

let runtime: Runtime;
let handle: ServerHandle;
let results: CaseResult[] = [];

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  const { conversationId } = await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: `tell me about ${FIXTURE_TEXT}`,
  });
  handle = startServer({ runtime, port: 0 });
  results = await runConformance({
    server: `http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`,
    publicOnly: true,
    carriage: "none",
    protocolVersion: MCP_PROTOCOL_VERSION,
    toolPrefix: "conversations__",
    fixture: conversationId,
    fixtureText: FIXTURE_TEXT,
  });
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

describe("conversations contract: the public tools at /mcp/<wsId>", () => {
  it("runs the public-only cases, including that private tools are absent", () => {
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.name);
    expect(names).toContain("no private tool is listed");
    expect(names).toContain("a private tool called here is refused");
    expect(names.some((n) => n.includes("forbidden"))).toBe(false);
  });

  it("passes every case it can state, except the door's known difference", () => {
    const failed = results
      .filter((r) => r.status === "fail" && !(r.name in KNOWN_DIFFERENCES))
      .map((r) => `${r.name}: ${r.detail}`);
    expect(failed).toEqual([]);
  });

  // When the door is fixed, this fails: delete the entry from KNOWN_DIFFERENCES.
  it("still differs from the contract only where KNOWN_DIFFERENCES says", () => {
    for (const [name, detail] of Object.entries(KNOWN_DIFFERENCES)) {
      const r = results.find((x) => x.name === name);
      expect(r?.status).toBe("fail");
      expect(r?.detail).toContain(detail);
    }
  });

  it("skips only the cases that state a second scope", () => {
    const skipped = results.filter((r) => r.status === "skip").map((r) => r.name);
    expect(skipped.sort()).toEqual(
      [
        "another owner's list does not show the caller's conversations",
        "the conversation in scope is the one an omitted id names",
        "tools/call with no workspace in scope is scope_missing",
      ].sort(),
    );
  });
});
