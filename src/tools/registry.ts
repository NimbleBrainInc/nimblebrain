import { textContent } from "../engine/content-helpers.ts";
import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";
import type { Tool, ToolSource } from "./types.ts";

/**
 * Non-stoppable reference wrapper for shared ToolSource objects.
 * When protected sources (e.g., default bundles, system tools) are added to
 * per-workspace registries, this wrapper prevents workspace cleanup from
 * stopping the underlying shared process.
 */
export class SharedSourceRef implements ToolSource {
  constructor(private readonly inner: ToolSource) {}
  get name(): string {
    return this.inner.name;
  }
  async start(): Promise<void> {
    // No-op — lifecycle owned by the original source
  }
  async stop(): Promise<void> {
    // No-op — prevents workspace registry cleanup from killing the shared process
  }
  tools(): Promise<Tool[]> {
    return this.inner.tools();
  }
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    return this.inner.execute(toolName, input);
  }
}

/**
 * Aggregates multiple ToolSources into a single ToolRouter.
 * Routes execute() calls by prefix: "sourceName__toolName".
 */
export class ToolRegistry implements ToolRouter {
  private sources = new Map<string, ToolSource>();

  addSource(source: ToolSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`Source "${source.name}" is already registered`);
    }
    this.sources.set(source.name, source);
  }

  async removeSource(name: string): Promise<void> {
    const source = this.sources.get(name);
    if (source) {
      await source.stop();
      this.sources.delete(name);
    }
  }

  async availableTools(): Promise<ToolSchema[]> {
    const all: ToolSchema[] = [];
    for (const source of this.sources.values()) {
      const tools = await source.tools();
      for (const tool of tools) {
        all.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
    }
    return all;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const sepIndex = call.name.indexOf("__");
    if (sepIndex === -1) {
      // Auto-search for matching tools to help the LLM recover
      const suggestions = await this.searchTools(call.name);
      const hint =
        suggestions.length > 0
          ? `\n\nDid you mean one of these?\n${suggestions.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
          : "";
      return {
        content: textContent(
          `Invalid tool name "${call.name}". Tool names must use the format "source__tool" (e.g., "synapse-crm__create_contact").${hint}\n\nUse nb__search to discover available tools.`,
        ),
        isError: true,
      };
    }

    const prefix = call.name.slice(0, sepIndex);
    const localName = call.name.slice(sepIndex + 2);

    const source = this.sources.get(prefix);
    if (!source) {
      const available = [...this.sources.keys()].join(", ");
      return {
        content: textContent(
          `Unknown source "${prefix}". Available sources: ${available || "none"}. Use nb__search to discover available tools.`,
        ),
        isError: true,
      };
    }

    return source.execute(localName, call.input);
  }

  /** Search all tools by keyword (substring match on name + description). */
  private async searchTools(query: string): Promise<Array<{ name: string; description: string }>> {
    const q = query.toLowerCase();
    const all = await this.availableTools();
    return all
      .filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .slice(0, 5)
      .map((t) => ({ name: t.name, description: t.description }));
  }

  /** Get all registered source names. */
  sourceNames(): string[] {
    return [...this.sources.keys()];
  }

  /** Check if a source is registered. */
  hasSource(name: string): boolean {
    return this.sources.has(name);
  }

  /** Get all registered sources. */
  getSources(): ToolSource[] {
    return [...this.sources.values()];
  }
}
