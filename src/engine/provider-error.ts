/**
 * Reading a provider error's HTTP status, whichever SDK threw it.
 *
 * The engine calls `model.doStream()`, so provider failures arrive as the AI
 * SDK's `APICallError`, which carries the code in `statusCode`. Other errors
 * (a vendor SDK, a test double) carry it in `status`. Both are read here so
 * every classifier sees the same number.
 */
export function providerStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  if (typeof status === "number") return status;
  if (typeof statusCode === "number") return statusCode;
  return undefined;
}
