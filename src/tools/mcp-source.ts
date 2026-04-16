import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../engine/types.ts";
import { createRemoteTransport } from "./remote-transport.ts";
import type { ResourceData, Tool, ToolSource } from "./types.ts";

export type { ResourceData } from "./types.ts";

export interface McpSpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** Discriminated union for how McpSource connects to its MCP server. */
export type McpTransportMode =
  | { type: "stdio"; spawn: McpSpawnConfig }
  | { type: "remote"; url: URL; transportConfig?: RemoteTransportConfig };

/**
 * ToolSource wrapping a single MCP server (stdio subprocess or remote HTTP/SSE).
 * Lazy tool loading: first tools() call triggers listTools(), then caches.
 * Crash recovery: on execute failure, attempts one restart + retry.
 */
export class McpSource implements ToolSource {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cachedTools: Tool[] | null = null;
  private dead = false;
  private startedAt: number | null = null;

  constructor(
    readonly name: string,
    private mode: McpTransportMode,
    private eventSink?: EventSink,
  ) {}

  /** Whether this source connects to a remote MCP server (HTTP/SSE). */
  isRemote(): boolean {
    return this.mode.type === "remote";
  }

  async start(): Promise<void> {
    if (this.mode.type === "stdio") {
      this.transport = new StdioClientTransport({
        command: this.mode.spawn.command,
        args: this.mode.spawn.args,
        env: this.mode.spawn.env,
        cwd: this.mode.spawn.cwd,
        stderr: "pipe",
      });
    } else {
      this.transport = createRemoteTransport(this.mode.url, this.mode.transportConfig);

      // Remote: watch for transport close — mark source as dead
      this.transport.onclose = () => {
        this.dead = true;
        this.eventSink?.emit({
          type: "run.error",
          data: { source: this.name, event: "source.crashed", error: "Remote transport closed" },
        });
      };
    }

    this.client = new Client({ name: "nimblebrain", version: "0.1.0" }, { capabilities: {} });

    // Timeout MCP handshake — remote gets shorter timeout (15s vs 30s)
    const CONNECT_TIMEOUT = this.mode.type === "remote" ? 15_000 : 30_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`MCP connect timeout after ${CONNECT_TIMEOUT / 1000}s for ${this.name}`),
          ),
        CONNECT_TIMEOUT,
      ),
    );

    try {
      await Promise.race([this.client.connect(this.transport), timeout]);
    } catch (err) {
      // Clean up on failure
      try {
        if (this.transport) await this.transport.close();
      } catch (cleanupErr) {
        console.error("[mcp-source] transport cleanup failed:", cleanupErr);
      }
      this.client = null;
      this.transport = null;
      throw err;
    }

    this.dead = false;
    this.startedAt = Date.now();
  }

  /** Check if the transport is still connected. */
  isAlive(): boolean {
    return this.transport !== null && this.client !== null && !this.dead;
  }

  /** Time (ms) since the source was last started, or null if never started. */
  uptime(): number | null {
    if (this.startedAt === null) return null;
    return Date.now() - this.startedAt;
  }

  /** Restart the source (stop + start). Returns true on success. */
  async restart(): Promise<boolean> {
    return this.tryRestart();
  }

  async stop(): Promise<void> {
    try {
      if (this.client) await this.client.close();
      if (this.transport) await this.transport.close();
    } catch (err) {
      console.error("[mcp-source] stop failed:", err);
    }
    this.client = null;
    this.transport = null;
    this.cachedTools = null;
  }

  async tools(): Promise<Tool[]> {
    if (this.cachedTools) return this.cachedTools;
    if (!this.client) throw new Error(`McpSource "${this.name}" not started`);

    const response = await this.client.listTools();
    this.cachedTools = response.tools.map((t) => ({
      name: `${this.name}__${t.name}`,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      source: `mcpb:${this.name}`,
      annotations: t._meta as Record<string, unknown> | undefined,
    }));
    return this.cachedTools;
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client || this.dead) {
      return { content: textContent(`McpSource "${this.name}" not started`), isError: true };
    }

    try {
      return await this.callTool(toolName, input);
    } catch (err) {
      // Crash detected — attempt one restart
      this.dead = true;
      this.eventSink?.emit({
        type: "run.error",
        data: { source: this.name, event: "source.crashed", error: String(err) },
      });

      const restarted = await this.tryRestart();
      if (restarted) {
        try {
          return await this.callTool(toolName, input);
        } catch (retryErr) {
          return {
            content: textContent(
              `Retry failed after restart: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
            ),
            isError: true,
          };
        }
      }
      return {
        content: textContent(`Server crashed and could not restart: ${this.name}`),
        isError: true,
      };
    }
  }

  /**
   * Read a resource from the MCP server (e.g. ui:// resources).
   * Returns structured resource data, or null if not found.
   */
  async readResource(uri: string): Promise<ResourceData | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.readResource({ uri });
      if (!result.contents || result.contents.length === 0) return null;
      const first = result.contents[0]!;
      if ("text" in first && typeof first.text === "string") {
        return { text: first.text, mimeType: first.mimeType };
      }
      if ("blob" in first && typeof first.blob === "string") {
        const raw = atob(first.blob);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return { blob: bytes, mimeType: first.mimeType };
      }
      return { text: JSON.stringify(first) };
    } catch {
      // Resource not found is expected (e.g., skill:// on servers that don't have one)
      return null;
    }
  }

  /** Expose the underlying MCP client for task operations (ss13). */
  getClient(): Client | null {
    return this.client;
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.client?.callTool({ name: toolName, arguments: args });
    if (!result) return { content: [], isError: true };

    // Detect CreateTaskResult — server returned a task instead of immediate result (ss13)
    const raw = result as Record<string, unknown>;
    if (raw.task && typeof raw.task === "object") {
      const task = raw.task as Record<string, unknown>;
      if (typeof task.taskId === "string" && typeof task.status === "string") {
        return {
          content: textContent(task.statusMessage ? String(task.statusMessage) : "Task created"),
          isError: false,
          _taskResult: {
            task: {
              taskId: task.taskId as string,
              status: task.status as string,
              ttl: (task.ttl as number | null) ?? null,
              createdAt: (task.createdAt as string) ?? new Date().toISOString(),
              lastUpdatedAt: (task.lastUpdatedAt as string) ?? new Date().toISOString(),
              pollInterval: task.pollInterval as number | undefined,
              statusMessage: task.statusMessage as string | undefined,
            },
            _meta: raw._meta as Record<string, unknown> | undefined,
          },
        };
      }
    }

    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: (result as Record<string, unknown>).structuredContent as
        | Record<string, unknown>
        | undefined,
      isError: Boolean(result.isError),
    };
  }

  private async tryRestart(): Promise<boolean> {
    try {
      await this.stop();
      await this.start();
      this.cachedTools = null;
      this.dead = false;
      this.eventSink?.emit({
        type: "run.error",
        data: { source: this.name, event: "source.restarted" },
      });
      return true;
    } catch (err) {
      this.eventSink?.emit({
        type: "run.error",
        data: { source: this.name, event: "source.restart_failed", error: String(err) },
      });
      return false;
    }
  }
}
