/**
 * Platform tool schema shape — convention enforcement.
 *
 * The LLM-facing JSON Schema is a contract. To stop a model from inventing
 * structure under-spec (e.g. serializing a nested object as a JSON-string),
 * every `object`-typed property must declare its inner `properties`. A bare
 * `{ type: "object" }` invites the model to free-associate and produces the
 * `manifest: "..."` mistake we saw in conv_30076c3681ad4c91.
 *
 * This test walks each platform source's `tools/list` output and asserts:
 *   1. Every tool input schema is itself a typed object.
 *   2. Every nested property of type `"object"` declares `properties`.
 *   3. Every `array` declares `items`.
 *
 * Adding a new platform source: register its factory in the `SOURCES`
 * array below. Adding a new tool to an existing source: nothing to do —
 * the test picks it up automatically via `tools/list`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createConversationsSource } from "../../../../src/tools/platform/conversations.ts";
import { createFilesSource } from "../../../../src/tools/platform/files.ts";
import { createInstructionsSource } from "../../../../src/tools/platform/instructions.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

// ── Minimal Runtime stub ─────────────────────────────────────────────────
//
// Each source's factory pokes at a different subset of the Runtime API.
// The schema-shape test never invokes a handler — it only lists tools —
// so the stub returns benign defaults from every method anyone might
// reach during construction.

function makeRuntimeStub(workDir: string): unknown {
  return {
    getWorkDir: () => workDir,
    getCurrentIdentity: () => null,
    getIdentityProvider: () => null,
    requireWorkspaceId: () => "_dev",
    getCurrentWorkspaceId: () => "_dev",
    getConversationStore: () => ({}),
    getInstructionsStore: () => ({
      read: async () => "",
      write: async () => ({ updated_at: new Date().toISOString() }),
    }),
    getWorkspaceStore: () => ({ get: async () => null }),
    getWorkspaceScopedDir: () => workDir,
    getRequestContext: () => null,
    getDefaultModel: () => "echo:test",
    getContextSkills: () => [],
    getMatchableSkills: () => [],
    loadConversationSkills: () => [],
  };
}

// ── Source registry ──────────────────────────────────────────────────────

const SOURCES = [
  { name: "skills", factory: createSkillsSource },
  { name: "instructions", factory: createInstructionsSource },
  { name: "files", factory: createFilesSource },
  { name: "conversations", factory: createConversationsSource },
] as const;

// ── Schema walker ────────────────────────────────────────────────────────

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/**
 * Walks a JSON Schema node, returning a list of paths where the
 * convention is violated. Empty list means the schema is well-formed.
 */
function findShapeViolations(node: SchemaNode, path = ""): string[] {
  const violations: string[] = [];

  // type === "object" with no properties
  const isObjectType =
    node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
  if (isObjectType && !node.properties) {
    violations.push(`${path}: object type missing 'properties'`);
  }

  // Recurse into children
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      violations.push(...findShapeViolations(child, `${path}.${key}`));
    }
  }
  if (node.items) {
    // type === "array" with no items would be a problem, but JSON Schema
    // doesn't mandate items for arrays. We only validate when items is
    // present — recurse into it.
    violations.push(...findShapeViolations(node.items, `${path}[]`));
  }
  // Also flag arrays with no items at all, where arrays appear.
  const isArrayType =
    node.type === "array" || (Array.isArray(node.type) && node.type.includes("array"));
  if (isArrayType && !node.items) {
    violations.push(`${path}: array type missing 'items'`);
  }

  return violations;
}

// ── Test ─────────────────────────────────────────────────────────────────

let workDir: string;
const sourcesToStop: McpSource[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "schema-shape-"));
});

afterEach(async () => {
  for (const src of sourcesToStop) {
    await src.stop();
  }
  sourcesToStop.length = 0;
  rmSync(workDir, { recursive: true, force: true });
});

describe("platform tool schemas — convention shape", () => {
  for (const { name, factory } of SOURCES) {
    test(`${name}: every tool input schema is fully typed`, async () => {
      const runtime = makeRuntimeStub(workDir);
      // The factory is permissive about the runtime shape — it only
      // calls methods at handler dispatch time, not during construction
      // (or right after, for source.start()).
      // biome-ignore lint/suspicious/noExplicitAny: factory signatures vary; the runtime stub satisfies each at call time
      const src = await Promise.resolve(factory(runtime as any, new NoopEventSink()));
      sourcesToStop.push(src);
      await src.start();

      const client = src.getClient();
      if (!client) throw new Error(`${name} source has no client`);
      const { tools } = await client.listTools();

      const allViolations: string[] = [];
      for (const tool of tools) {
        // Every tool must declare an object-shaped input schema with properties.
        const schema = tool.inputSchema as SchemaNode;
        if (schema.type !== "object") {
          allViolations.push(`${tool.name}: top-level inputSchema must be type 'object'`);
          continue;
        }
        if (!schema.properties) {
          allViolations.push(`${tool.name}: top-level inputSchema missing 'properties'`);
          continue;
        }
        const violations = findShapeViolations(schema, tool.name);
        allViolations.push(...violations);
      }

      // Detail-rich failure message — when a future tool drifts, the
      // message itself tells the contributor exactly which property at
      // which path needs `properties` or `items`.
      if (allViolations.length > 0) {
        throw new Error(
          `Platform source "${name}" has ${allViolations.length} schema-shape violation(s):\n  ${allViolations.join("\n  ")}\n\n` +
            `Every \`object\`-typed property must declare \`properties\`. Every \`array\` must declare \`items\`. ` +
            `Bare \`{ type: "object" }\` lets the model invent structure under-spec — see src/tools/platform/skills.ts for the canonical pattern.`,
        );
      }
      expect(allViolations).toHaveLength(0);
    });
  }
});
