import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

/**
 * Tests the runtime permission gate inside `ToolRegistry.execute`. The
 * PermissionStore has its own coverage; this file proves the wiring
 * between dispatch and enforcement — that a `disallow` policy
 * short-circuits with `tool_permission_denied` before reaching the
 * source's execute method.
 */

class MockSource implements ToolSource {
  readonly name: string;
  callCount = 0;
  constructor(name: string) {
    this.name = name;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      {
        name: `${this.name}__readonly`,
        description: "Readonly tool",
        inputSchema: {},
        source: this.name,
      },
      {
        name: `${this.name}__destructive`,
        description: "Destructive tool",
        inputSchema: {},
        source: this.name,
      },
    ];
  }
  async execute(toolName: string): Promise<ToolResult> {
    this.callCount++;
    return { content: textContent(`mock ${toolName} ok`), isError: false };
  }
}

function freshRegistry(): {
  registry: ToolRegistry;
  source: MockSource;
  permStore: PermissionStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-perm-gate-"));
  const registry = new ToolRegistry();
  const source = new MockSource("mock");
  registry.addSource(source);
  const permStore = new PermissionStore(dir);
  return { registry, source, permStore, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("ToolRegistry.execute permission gate", () => {
  test("without permission context configured, calls pass through", async () => {
    const { registry, source, cleanup } = freshRegistry();
    try {
      const result = await registry.execute({ name: "mock__readonly", input: {} });
      expect(result.isError).toBe(false);
      expect(source.callCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("with permission context but no policies set, calls pass through (default-allow)", async () => {
    const { registry, source, permStore, cleanup } = freshRegistry();
    try {
      registry.setPermissionContext("ws_test", permStore);
      const result = await registry.execute({ name: "mock__readonly", input: {} });
      expect(result.isError).toBe(false);
      expect(source.callCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("disallowed tool returns tool_permission_denied without invoking source", async () => {
    const { registry, source, permStore, cleanup } = freshRegistry();
    try {
      registry.setPermissionContext("ws_test", permStore);
      await permStore.setConnector(
        { scope: "workspace", wsId: "ws_test" },
        "mock",
        { destructive: "disallow" },
      );
      const result = await registry.execute({ name: "mock__destructive", input: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: "tool_permission_denied",
        connector: "mock",
        tool: "destructive",
        scope: "workspace",
      });
      expect(source.callCount).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("explicit allow policy permits the call", async () => {
    const { registry, source, permStore, cleanup } = freshRegistry();
    try {
      registry.setPermissionContext("ws_test", permStore);
      await permStore.setConnector(
        { scope: "workspace", wsId: "ws_test" },
        "mock",
        { readonly: "allow" },
      );
      const result = await registry.execute({ name: "mock__readonly", input: {} });
      expect(result.isError).toBe(false);
      expect(source.callCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("policies are scoped per connector — disallow on connector A doesn't block connector B", async () => {
    const { registry, source, permStore, cleanup } = freshRegistry();
    try {
      const sourceB = new MockSource("other");
      registry.addSource(sourceB);
      registry.setPermissionContext("ws_test", permStore);
      await permStore.setConnector(
        { scope: "workspace", wsId: "ws_test" },
        "mock",
        { readonly: "disallow" },
      );
      // Same tool name on different connector — should not be blocked.
      const result = await registry.execute({ name: "other__readonly", input: {} });
      expect(result.isError).toBe(false);
      expect(sourceB.callCount).toBe(1);
      expect(source.callCount).toBe(0);
    } finally {
      cleanup();
    }
  });
});
