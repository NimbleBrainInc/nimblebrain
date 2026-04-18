import type { PlacementDeclaration } from "../bundles/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { Tool, ToolSource } from "./types.ts";
import { validateToolInput } from "./validate-input.ts";

export interface InlineToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
  /** Optional annotations. Use `"ai.nimblebrain/internal": true` to hide from the agent's tool list. */
  annotations?: Record<string, unknown>;
}

function errorResult(message: string): ToolResult {
  return {
    content: textContent(JSON.stringify({ error: message })),
    isError: true,
  };
}

/**
 * ToolSource for tools defined directly in code.
 *
 * Enforces the declared input contract before handlers run: every tool call
 * is validated against its `inputSchema` so missing or wrongly-typed params
 * never leak Node-internal errors (fs.readFile, Buffer.from, etc.) as tool
 * results. Every in-process bundle inherits this guarantee.
 *
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

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    const def = this.toolDefs.find((d) => d.name === toolName);
    if (!def) {
      const available = this.toolDefs.map((d) => d.name).join(", ");
      return errorResult(
        `Unknown tool "${toolName}" in source "${this.name}". Available: ${available}`,
      );
    }

    const validation = validateToolInput(input, def.inputSchema);
    if (!validation.valid) {
      return errorResult(`Invalid arguments for "${def.name}": ${validation.error}`);
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
