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

/**
 * The model provider has no valid API key: the key is missing, so the provider
 * client threw before sending, or the provider rejected it (HTTP 401).
 *
 * Raised only for a direct provider call, where the runtime holds the key.
 * Retrying cannot fix it: the key has to change, and the provider clients read
 * their keys at startup. `code` is the stream error code the runtime sends to
 * the browser, so the chat states the fix and offers no retry.
 */
export class ModelAuthError extends Error {
  readonly code = "model_auth_failed";

  constructor(provider: string, options?: ErrorOptions) {
    const keyFor = provider ? ` for ${provider}` : "";
    super(
      `The model provider has no valid API key. Set one${keyFor} and restart NimbleBrain.`,
      options,
    );
    this.name = "ModelAuthError";
  }
}
