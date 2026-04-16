import type { ToolResult } from "../engine/types.ts";

/** A tool with source tracking. Extends ToolSchema with a source field. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: string; // "mcpb:leadgen" | "upjack:crm" | "inline"
  /** MCP tool annotations (_meta). Includes UI metadata like resourceUri. */
  annotations?: Record<string, unknown>;
}

/** Pluggable tool provider. Each source manages its own lifecycle. */
export interface ToolSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  tools(): Promise<Tool[]>;
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
}

export type { ToolResult } from "../engine/types.ts";

/** Structured resource content returned by MCP resource reads. */
export interface ResourceData {
  text?: string;
  blob?: Uint8Array;
  mimeType?: string;
}

/** A ToolSource that can also read MCP resources. */
export interface ResourceReader {
  readResource(uri: string): Promise<ResourceData | null>;
}

/** Type guard: does a ToolSource support readResource? */
export function isResourceReader(source: unknown): source is ToolSource & ResourceReader {
  return source != null && typeof (source as Record<string, unknown>).readResource === "function";
}
