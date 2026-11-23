/**
 * A missing or rejected key on a provider the runtime calls directly.
 *
 * Without the installation's model gateway, `buildRegistry` builds each
 * provider with a key the runtime holds, so a key that is missing or rejected
 * is the runtime's to fix. `modelAuthMiddleware` wraps those providers' models
 * and fails such a call as `ModelAuthError`, naming the provider. Behind the
 * gateway the gateway holds the keys, the models are not wrapped, and a 401
 * fails as the provider client raised it.
 *
 * The middleware sits around the model, not `fetch`: a client with no key
 * throws `LoadAPIKeyError` from its per-request headers inside `doStream`,
 * before any request is sent.
 */

import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "ai";

/**
 * The model provider has no valid API key. Retrying cannot fix it: the key has
 * to change, and the provider clients read their keys at startup. `code` is the
 * stream error code the runtime sends to the browser, so the chat states the
 * fix and offers no retry. It carries no status and no retry verdict, so
 * `withRetry` fails it at once.
 */
export class ModelAuthError extends Error {
  override readonly name = "ModelAuthError";
  readonly code = "model_auth_failed";

  /** `provider` is the provider whose key failed, or `undefined` when no provider is configured. */
  constructor(provider: string | undefined, options?: ErrorOptions) {
    super(
      provider === undefined
        ? "No model provider is configured. Set a provider's API key, or providers.local for a model server you run, and restart NimbleBrain."
        : `The model provider has no valid API key. Set one for ${provider} and restart NimbleBrain.`,
      options,
    );
  }
}

/**
 * A model names a provider the configuration does not build. Raised by the
 * resolver before any provider client is called, with the same code as
 * `ModelAuthError`, so the chat states the fix and offers no retry. When
 * `providers.local` is configured with no `models`, the runtime has no local
 * model to default to, and the message names that list rather than the provider
 * the fallback default happened to name.
 */
export class ModelProviderNotConfiguredError extends ModelAuthError {
  constructor(provider: string, localWithoutModels: boolean) {
    super(provider);
    this.message = localWithoutModels
      ? "providers.local lists no models, so there is no local model to use. Add your model server's model ids to providers.local.models, or set models.default to local:<model-id>, and restart NimbleBrain."
      : `The model provider ${provider} is not configured. Set its API key, or choose a model of a configured provider, and restart NimbleBrain.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Gemini answers a key it does not accept with 400 `INVALID_ARGUMENT` and the
 * reason `API_KEY_INVALID` in the error's details, not with 401.
 */
function isGeminiKeyRejected(err: APICallError): boolean {
  if (err.statusCode !== 400 || !isRecord(err.data) || !isRecord(err.data.error)) return false;
  const { details } = err.data.error;
  return (
    Array.isArray(details) && details.some((d) => isRecord(d) && d.reason === "API_KEY_INVALID")
  );
}

/** Whether `err` says the provider's key is missing or rejected. */
function isKeyFailure(provider: string, err: unknown): boolean {
  if (LoadAPIKeyError.isInstance(err)) return true;
  if (!APICallError.isInstance(err)) return false;
  return err.statusCode === 401 || (provider === "google" && isGeminiKeyRejected(err));
}

/** Fails a call whose key is missing or rejected as `ModelAuthError(provider)`. */
export function modelAuthMiddleware(provider: string): LanguageModelV4Middleware {
  const translate = (err: unknown): unknown =>
    isKeyFailure(provider, err) ? new ModelAuthError(provider, { cause: err }) : err;
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      try {
        return await doGenerate();
      } catch (err) {
        throw translate(err);
      }
    },
    wrapStream: async ({ doStream }) => {
      try {
        return await doStream();
      } catch (err) {
        throw translate(err);
      }
    },
  };
}
