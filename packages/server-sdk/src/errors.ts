/**
 * A contract tool's failure: a `tools/call` result with `isError: true` whose first text
 * content is JSON `{ code, error }`. A caller decides on `code`, from the contract's closed
 * list; `error` is for people and models.
 */

export interface ToolErrorBody {
  code: string;
  error: string;
}

export interface ToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  [key: string]: unknown;
}

/** The result for a failed call. */
export function toolError(code: string, error: string): ToolErrorResult {
  const body: ToolErrorBody = { code, error };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** A failure a handler throws; the server turns it into {@link toolError}. */
export class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}
