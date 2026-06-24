/**
 * End-to-end contract test for the skills create flow as the web admin UI
 * ("rules for your agent") drives it.
 *
 * Two regressions are pinned here:
 *
 *  1. Contract shape — the web client sends `name` inside `manifest`, not at
 *     the args root. Three hand-written declarations (server schema literal,
 *     server CreateInput, web CreateInput) once disagreed; the schema-derived
 *     `ToolInput<"skills", "create">` keeps them aligned.
 *
 *  2. Valid-by-construction rules — the editor used to post `description: ""`
 *     and no `loading-strategy`. The empty description passed the (then-lax)
 *     tool schema and was written to disk, but the loader's canonical
 *     validation rejected it, so the skill was invisible to list/read (a
 *     silent orphan) and a retry collided with "already exists". And with no
 *     `loading-strategy` the skill defaulted to `dynamic` with no triggers —
 *     catalog-only, i.e. it never loaded. The UI now sends the title as a
 *     non-empty `description` and `loadingStrategy: "always"`. These tests
 *     post that exact shape and assert the rule is created, visible, and
 *     actually loads — and that the old broken shape is rejected with no
 *     orphan left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolInput } from "../../src/tools/platform/schemas/catalog.ts";
import type {
  SkillDetail,
  SkillsListOutput,
} from "../../src/tools/platform/schemas/skills.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `skills-create-from-web-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

interface ToolCallResult {
  status: number;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  error?: string;
  message?: string;
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const res = await fetch(`${baseUrl}/v1/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: JSON.stringify({ server: "skills", tool, arguments: args }),
  });
  const body = (await res.json()) as Omit<ToolCallResult, "status">;
  return { status: res.status, ...body };
}

describe("skills__create — web 'rules' payload contract", () => {
  it("creates an always-on rule from the real UI payload, and it loads", async () => {
    // Exactly what SkillsTab.tsx posts now: title → non-empty `description`,
    // `loadingStrategy: "always"`, no `type`, no explicit priority (server
    // default 50). Shape-checked against the catalog at compile time.
    const args: ToolInput<"skills", "create"> = {
      scope: "workspace",
      manifest: {
        name: "voice-rules",
        description: "Voice rules",
        loadingStrategy: "always",
      },
      body: "Match my writing voice. Avoid em-dashes.\n",
    };

    const created = await callTool("create", args);
    expect(created.status).toBe(200);
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent?.name).toBe("voice-rules");
    expect(created.structuredContent?.loadingStrategy).toBe("always");
    const id = created.structuredContent?.id as string;
    expect(id).toMatch(/voice-rules\.md$/);

    // Visible to list (the orphan bug made it invisible), and reported as a
    // skill that actually reaches the prompt.
    const list = await callTool("list", { scope: "workspace" });
    const listed = (list.structuredContent as unknown as SkillsListOutput).skills.find(
      (s) => s.id === id,
    );
    expect(listed).toBeDefined();
    expect(listed?.loadingStrategy).toBe("always");
    expect(listed?.loading?.wouldLoad).toBe(true);
    expect(listed?.loading?.mechanism).toBe("always");

    // Readable, with the title preserved as the description label.
    const read = await callTool("read", { id });
    expect(read.isError).toBeFalsy();
    const detail = read.structuredContent as unknown as SkillDetail;
    expect(detail.metadata.loadingStrategy).toBe("always");
    expect(detail.metadata.description).toBe("Voice rules");
    expect(detail.content).toContain("Avoid em-dashes");
  });

  it("rejects an empty-description payload and leaves no orphan", async () => {
    // The old broken shape: empty description, no loading-strategy. This must
    // be rejected at the schema boundary BEFORE anything is written, so a
    // retry collides with nothing.
    const broken = {
      scope: "workspace",
      manifest: { name: "orphan-rule", description: "" },
      body: "test",
    };

    const first = await callTool("create", broken);
    expect(first.status).toBe(400);
    expect(first.error).toBe("invalid_input");

    // No file was written → not in the list…
    const list = await callTool("list", { scope: "workspace" });
    const orphan = (list.structuredContent as unknown as SkillsListOutput).skills.find((s) =>
      s.id.endsWith("orphan-rule.md"),
    );
    expect(orphan).toBeUndefined();

    // …and a retry is still a clean validation error, NOT "already exists".
    const second = await callTool("create", broken);
    expect(second.status).toBe(400);
    expect(second.error).toBe("invalid_input");
    expect(second.message ?? "").not.toMatch(/already exists/);
  });

  it("rejects a payload with name at the root (the original contract bug)", async () => {
    // name at the args root, not inside manifest — must 400 with the schema
    // validator error, not create anything.
    const malformed = {
      scope: "workspace",
      name: "should-fail",
      manifest: { description: "no name in manifest" },
      body: "irrelevant",
    };

    const res = await callTool("create", malformed);
    expect(res.status).toBe(400);
    expect(res.error).toBe("invalid_input");
    expect(res.message ?? "").toMatch(/manifest/);
  });
});
