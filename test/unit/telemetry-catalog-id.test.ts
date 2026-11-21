import { describe, expect, it } from "bun:test";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { telemetryCatalogId } from "../../src/telemetry/catalog-id.ts";

const todos = {
  id: "ai.nimblebrain.todos/mcp",
  name: "To-dos",
  description: "",
  url: "http://mcp-todos.mcp-shared.svc.cluster.local/mcp",
  auth: "provider",
} as ConnectorCatalogEntry;

describe("telemetryCatalogId", () => {
  it("names a catalog connector whose stored URL differs only in form", () => {
    const ref: ConnectorRef = {
      serverName: "ai-nimblebrain-todos-mcp",
      url: "http://MCP-TODOS.mcp-shared.svc.cluster.local:80/mcp/",
    };
    expect(telemetryCatalogId(ref, [todos])).toBe("ai.nimblebrain.todos/mcp");
  });

  it("leaves a connector that only borrows a catalog name unnamed", () => {
    const ref: ConnectorRef = {
      serverName: "ai-nimblebrain-todos-mcp",
      url: "https://elsewhere.example/mcp",
    };
    expect(telemetryCatalogId(ref, [todos])).toBeUndefined();
  });

  it("leaves a connector added by URL unnamed", () => {
    const ref: ConnectorRef = { serverName: "acme-internal", url: "https://acme.example/mcp" };
    expect(telemetryCatalogId(ref, [todos])).toBeUndefined();
  });
});
