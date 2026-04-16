import type { PlacementDeclaration } from "../bundles/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { Tool, ToolSource } from "./types.ts";

export interface InlineToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
  /** Optional annotations. Use `"ai.nimblebrain/internal": true` to hide from the agent's tool list. */
  annotations?: Record<string, unknown>;
}

/**
 * ToolSource for tools defined directly in code.
 * start() and stop() are no-ops. Tools are returned with source prefix.
 * Optionally serves ui:// resources and declares UI placements.
 */
export class InlineSource implements ToolSource {
  private resourceMap: Map<string, string>;
  private _placements: PlacementDeclaration[];

  constructor(
    readonly name: string,
    private toolDefs: InlineToolDef[],
    options?: {
      resources?: Map<string, string>;
      placements?: PlacementDeclaration[];
    },
  ) {
    this.resourceMap = options?.resources ?? new Map();
    this._placements = options?.placements ?? [];
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async tools(): Promise<Tool[]> {
    return this.toolDefs.map((def) => ({
      name: `${this.name}__${def.name}`,
      description: def.description,
      inputSchema: def.inputSchema,
      source: `inline:${this.name}`,
      annotations: def.annotations,
    }));
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    const def = this.toolDefs.find((d) => d.name === toolName);
    if (!def) {
      const available = this.toolDefs.map((d) => d.name).join(", ");
      return {
        content: textContent(
          `Unknown tool "${toolName}" in source "${this.name}". Available: ${available}`,
        ),
        isError: true,
      };
    }
    return def.handler(input);
  }

  /** Read a ui:// resource by path. Returns HTML string or null. */
  readResource(resourcePath: string): string | null {
    return this.resourceMap.get(resourcePath) ?? null;
  }

  /** Get declared UI placements for this source. */
  getPlacements(): PlacementDeclaration[] {
    return this._placements;
  }
}
