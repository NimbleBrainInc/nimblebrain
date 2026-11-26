import type { ToolCallResult } from "@nimblebrain/synapse";
import { useCallTool } from "@nimblebrain/synapse/react";
import { useCallback, useMemo } from "react";

/**
 * Throw a tool execution error as an `Error` carrying the tool's text.
 *
 * The host answers a tool's own failure as a result with `isError: true`
 * (MCP), not a rejected call. This panel reports failures from its `catch`
 * blocks, so it turns that result into a throw here, at the one place it calls
 * tools.
 */
export function throwIfToolError<T>(result: ToolCallResult<T>): ToolCallResult<T> {
  if (!result.isError) return result;
  const text = (result.content ?? [])
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
  throw new Error(text || "Tool error");
}

/**
 * `useCallTool` whose `call` rejects when the tool reports an error. The
 * returned object and its `call` keep their identity for the tool's lifetime,
 * so a hook lists either as a dependency without re-running each render.
 */
export function useTool<T = unknown>(
  toolName: string,
): { call: (args?: Record<string, unknown>) => Promise<ToolCallResult<T>> } {
  const { call: callTool } = useCallTool<T>(toolName);
  const call = useCallback(
    async (args?: Record<string, unknown>) => throwIfToolError(await callTool(args)),
    [callTool],
  );
  return useMemo(() => ({ call }), [call]);
}
