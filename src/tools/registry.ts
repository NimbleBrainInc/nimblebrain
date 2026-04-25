import { textContent } from "../engine/content-helpers.ts";
import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";
import type { McpSource } from "./mcp-source.ts";
import type { Tool, ToolSource } from "./types.ts";

/**
 * Structural check for "looks like an McpSource task-aware surface".
 *
 * The `/mcp` task handlers (Task 002) need a source that exposes the
 * per-phase task methods so they can route `tasks/get`, `tasks/result`,
 * and `tasks/cancel` back to the originating McpSource. We probe by shape
 * rather than `instanceof` to stay friendly to `SharedSourceRef`-wrapped
 * sources and to test doubles.
 */
export function isTaskAwareSource(
  source: ToolSource,
): source is ToolSource &
  Pick<McpSource, "startToolAsTask" | "awaitToolTaskResult" | "getTaskStatus" | "cancelTask"> {
  const s = source as Partial<McpSource>;
  return (
    typeof s.startToolAsTask === "function" &&
    typeof s.awaitToolTaskResult === "function" &&
    typeof s.getTaskStatus === "function" &&
    typeof s.cancelTask === "function"
  );
}

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
  execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.inner.execute(toolName, input, signal);
  }
  /** Unwrap to the underlying source — used by task-aware dispatch. */
  unwrap(): ToolSource {
    return this.inner;
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

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
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

    return source.execute(localName, call.input, signal);
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

  /** Look up a single source by name. Returns undefined when absent. */
  getSource(name: string): ToolSource | undefined {
    return this.sources.get(name);
  }

  /** Get all registered sources. */
  getSources(): ToolSource[] {
    return [...this.sources.values()];
  }

  /**
   * Look up the task-aware (McpSource-shaped) source by name, unwrapping
   * `SharedSourceRef` if necessary.
   *
   * Returns `null` if the name doesn't resolve to a source, or if the
   * underlying source doesn't implement the split task API. Used by the
   * `/mcp` endpoint (Task 002) to route `tasks/{get,result,cancel}` back
   * to the originating McpSource.
   */
  findTaskAwareSource(
    name: string,
  ):
    | (ToolSource &
        Pick<McpSource, "startToolAsTask" | "awaitToolTaskResult" | "getTaskStatus" | "cancelTask">)
    | null {
    const source = this.sources.get(name);
    if (!source) return null;
    const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
    return isTaskAwareSource(unwrapped) ? unwrapped : null;
  }
}
