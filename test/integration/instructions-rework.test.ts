/**
 * Bundle Instructions — bundle-side convention end-to-end.
 *
 * After the rework, the platform's contract is:
 *   - For every active bundle, the runtime reads `app://instructions`
 *     on every prompt assembly. If the body is non-empty, the platform wraps
 *     it in `<app-custom-instructions>` containment inside that bundle's
 *     block in the apps section.
 *   - Bundles that don't publish that resource get no overlay — naturally
 *     excluded with no negotiation. (Plain MCP servers like ipinfo end up
 *     here.)
 *   - Org and workspace overlays remain platform-owned, written via
 *     `instructions__write_instructions(scope, text)`.
 *
 * This test verifies the contract end-to-end by:
 *   (a) seeding a synthetic local bundle that publishes
 *       `app://instructions` and confirming the body lands in the
 *       composed system prompt with containment;
 *   (b) installing `mcp-servers/ipinfo` UNMODIFIED (it does NOT publish
 *       the resource) and confirming no overlay appears for it;
 *   (c) writing org/workspace overlays via the platform tool and
 *       confirming they appear in the composed system prompt.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// ── HQ root resolution ──────────────────────────────────────────────────

const HQ_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const IPINFO_BUNDLE_DIR = join(HQ_ROOT, "mcp-servers", "ipinfo");

const TEST_BUNDLE_INSTRUCTIONS_BODY =
  "When asked about widgets, always prefer the user's brand voice: terse and confident.";

// ── Synthetic bundle that publishes <name>://instructions ──────────────
//
// Minimal Node MCP server stamped into a temp dir at suite start. Publishes
// `app://instructions` with a fixed body so the platform's
// fetch-and-wrap contract has something to find.

const SYNTHETIC_BUNDLE_NAME = "@nbtest/widgets";
const SYNTHETIC_BUNDLE_SLUG = "widgets"; // deriveServerName takes the @scope/name suffix

function seedSyntheticBundle(root: string): string {
  const bundleDir = join(root, "widgets-bundle");
  mkdirSync(bundleDir, { recursive: true });

  const nodeModulesPath = join(import.meta.dir, "..", "..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "widgets", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Single trivial tool so the source isn't tool-empty.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "ping", description: "Health check.", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Publish the bundle-side convention: app://instructions.
  const INSTRUCTIONS_URI = "app://instructions";
  const INSTRUCTIONS_BODY = ${JSON.stringify(TEST_BUNDLE_INSTRUCTIONS_BODY)};
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: INSTRUCTIONS_URI, name: "Custom Instructions for widgets", mimeType: "text/markdown" },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === INSTRUCTIONS_URI) {
      return {
        contents: [{ uri: INSTRUCTIONS_URI, mimeType: "text/markdown", text: INSTRUCTIONS_BODY }],
      };
    }
    throw new Error("Resource not found: " + req.params.uri);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(bundleDir, "server.cjs"), serverCode);

  const manifest = {
    manifest_version: "0.3",
    name: SYNTHETIC_BUNDLE_NAME,
    version: "0.1.0",
    description: "Synthetic test bundle that publishes app://instructions",
    author: { name: "nbtest" },
    server: {
      type: "node",
      entry_point: "server.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.cjs"],
      },
    },
  };
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return bundleDir;
}

// ── CapturingModel — records system prompts ────────────────────────────
//
// Wraps an EchoModel so the test can inspect what reached the model
// boundary. We don't actually need to drive `chat()` for assertions A and B
// (we read `instructions://workspace` and assemble manually); the capture
// is for assertion D (overlay reaches the live prompt).

interface CapturedCall {
  systemPrompt: string;
  messages: LanguageModelV3Message[];
}

class CapturingModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "test";
  readonly modelId = "capturing";
  readonly supportedUrls = {};
  readonly calls: CapturedCall[] = [];

  reset(): void {
    this.calls.length = 0;
  }

  private extractSystemPrompt(messages: LanguageModelV3Message[]): string {
    const sys = messages.find((m) => m.role === "system");
    if (!sys) return "";
    if (typeof sys.content === "string") return sys.content;
    return sys.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  private extractLastUserText(messages: LanguageModelV3Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") return part.text;
      }
    }
    return "";
  }

  // biome-ignore lint/suspicious/useAwait: SDK signature requires async
  async doGenerate(callOptions: LanguageModelV3CallOptions) {
    const messages = callOptions.prompt;
    this.calls.push({ systemPrompt: this.extractSystemPrompt(messages), messages });
    const text = this.extractLastUserText(messages);
    return {
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    };
  }

  // biome-ignore lint/suspicious/useAwait: SDK signature requires async
  async doStream(callOptions: LanguageModelV3CallOptions) {
    const messages = callOptions.prompt;
    this.calls.push({ systemPrompt: this.extractSystemPrompt(messages), messages });
    const text = this.extractLastUserText(messages);
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "0" });
        controller.enqueue({ type: "text-delta", id: "0", delta: text });
        controller.enqueue({ type: "text-end", id: "0" });
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        controller.close();
      },
    });
    return { stream };
  }
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("bundle instructions — bundle-side convention", () => {
  let testRoot: string;
  let runtime: Runtime;
  let capturing: CapturingModel;
  let widgetsServerName: string;
  let ipinfoServerName: string;

  beforeAll(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "instructions-rework-"));
    const widgetsDir = seedSyntheticBundle(testRoot);

    capturing = new CapturingModel();
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: capturing },
      // @ts-expect-error — accepted at runtime; not exposed in RuntimeConfig
      noDefaultBundles: true,
      workDir: join(testRoot, "work"),
    });

    await provisionTestWorkspace(runtime);
    const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

    // Install both bundles via the lifecycle so the runtime tracks them
    // alongside other state.
    const widgetsInstance = await runtime.getLifecycle().installLocal(
      widgetsDir,
      wsRegistry,
      TEST_WORKSPACE_ID,
    );
    widgetsServerName = widgetsInstance.serverName;
    expect(widgetsServerName).toBe(SYNTHETIC_BUNDLE_SLUG);

    const ipinfoInstance = await runtime.getLifecycle().installLocal(
      IPINFO_BUNDLE_DIR,
      wsRegistry,
      TEST_WORKSPACE_ID,
    );
    ipinfoServerName = ipinfoInstance.serverName;
    expect(ipinfoServerName).toBe("ipinfo");
  });

  afterAll(async () => {
    await runtime.shutdown();
    rmSync(testRoot, { recursive: true, force: true });
  });

  test(
    "synthetic bundle's <name>://instructions body lands in composed prompt with <app-custom-instructions> containment",
    async () => {
      capturing.reset();

      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          await runtime.chat({
            message: "Tell me about widgets.",
            workspaceId: TEST_WORKSPACE_ID,
          });
        },
      );

      expect(capturing.calls.length).toBeGreaterThan(0);
      const systemPrompt = capturing.calls[0]!.systemPrompt;

      // The bundle-author body shows up under widgets' bullet, inside
      // <app-custom-instructions> containment.
      expect(systemPrompt).toContain("## Installed Apps");
      expect(systemPrompt).toContain(`- ${widgetsServerName} `);
      expect(systemPrompt).toContain("<app-custom-instructions>");
      expect(systemPrompt).toContain(TEST_BUNDLE_INSTRUCTIONS_BODY);
      expect(systemPrompt).toContain("</app-custom-instructions>");

      // Containment block sits inside widgets' apps-section block, after
      // its bullet header.
      const widgetsBulletIdx = systemPrompt.indexOf(`- ${widgetsServerName} `);
      const overlayOpenIdx = systemPrompt.indexOf("<app-custom-instructions>");
      expect(overlayOpenIdx).toBeGreaterThan(widgetsBulletIdx);
    },
    60_000,
  );

  test(
    "ipinfo (no <bundle>://instructions resource published) gets NO overlay block",
    async () => {
      capturing.reset();

      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          await runtime.chat({
            message: "What is 8.8.8.8?",
            workspaceId: TEST_WORKSPACE_ID,
          });
        },
      );

      const systemPrompt = capturing.calls[0]!.systemPrompt;

      // ipinfo's bullet is present.
      const ipinfoBulletIdx = systemPrompt.indexOf(`- ${ipinfoServerName} `);
      expect(ipinfoBulletIdx).toBeGreaterThan(-1);

      // The only `<app-custom-instructions>` block present is widgets' —
      // not ipinfo's. Verify by structural ordering: after widgets' bullet,
      // there's exactly one overlay block in the apps section, and ipinfo's
      // bullet appears before/after it without its own overlay.
      const widgetsBulletIdx = systemPrompt.indexOf(`- ${widgetsServerName} `);
      const overlayCount = (systemPrompt.match(/<app-custom-instructions>/g) ?? []).length;
      expect(overlayCount).toBe(1);

      // The single overlay is widgets', not ipinfo's. (Whichever bullet
      // comes first owns the next overlay block; we just assert the count
      // is 1 and widgets has the body.)
      expect(systemPrompt).toContain(TEST_BUNDLE_INSTRUCTIONS_BODY);

      // Belt-and-suspenders: ensure no overlay appears between ipinfo's
      // bullet and the next bullet (or end of section).
      const afterIpinfo = systemPrompt.slice(ipinfoBulletIdx);
      // Next bullet (or end-of-apps-section marker)
      const nextBulletIdx = afterIpinfo.search(/\n- |\n\n[^-]/);
      const ipinfoBlock = nextBulletIdx > 0 ? afterIpinfo.slice(0, nextBulletIdx) : afterIpinfo;
      expect(ipinfoBlock).not.toContain("<app-custom-instructions>");
      // Sanity — widgets bullet is somewhere too.
      expect(widgetsBulletIdx).toBeGreaterThan(-1);
    },
    60_000,
  );

  test(
    "instructions__write_instructions(scope=workspace) body reaches the live system prompt",
    async () => {
      const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
      const overlayText = "Workspace policy: prefer plaintext outputs over Markdown.";

      // Write via the platform tool (same path agent uses).
      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          const writeResult = await wsRegistry.execute({
            id: "test-write-ws",
            name: "instructions__write_instructions",
            input: { scope: "workspace", text: overlayText },
          });
          expect(writeResult.isError).toBe(false);
        },
      );

      capturing.reset();
      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          await runtime.chat({
            message: "Hello.",
            workspaceId: TEST_WORKSPACE_ID,
          });
        },
      );

      const systemPrompt = capturing.calls[0]!.systemPrompt;
      // Workspace overlay is rendered under its own heading + tag.
      expect(systemPrompt).toContain("## Workspace Instructions");
      expect(systemPrompt).toContain("<workspace-instructions>");
      expect(systemPrompt).toContain(overlayText);
      expect(systemPrompt).toContain("</workspace-instructions>");
    },
    60_000,
  );

  test(
    "writing empty workspace text clears it — next prompt has no Workspace Instructions block",
    async () => {
      const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          const clearResult = await wsRegistry.execute({
            id: "test-clear-ws",
            name: "instructions__write_instructions",
            input: { scope: "workspace", text: "" },
          });
          expect(clearResult.isError).toBe(false);
        },
      );

      capturing.reset();
      await runWithRequestContext(
        { workspaceId: TEST_WORKSPACE_ID, identity: null },
        async () => {
          await runtime.chat({
            message: "Hello again.",
            workspaceId: TEST_WORKSPACE_ID,
          });
        },
      );

      const systemPrompt = capturing.calls[0]!.systemPrompt;
      expect(systemPrompt).not.toContain("## Workspace Instructions");
      expect(systemPrompt).not.toContain("<workspace-instructions>");
    },
    60_000,
  );
});
