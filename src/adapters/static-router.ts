import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";

/** Returns a fixed set of tools with a configurable handler. For testing. */
export class StaticToolRouter implements ToolRouter {
  constructor(
    private tools: ToolSchema[],
    private handler: (call: ToolCall) => ToolResult | Promise<ToolResult>,
  ) {}

  async availableTools(): Promise<ToolSchema[]> {
    return this.tools;
  }

  async execute(call: ToolCall, _signal?: AbortSignal): Promise<ToolResult> {
    return this.handler(call);
  }
}
