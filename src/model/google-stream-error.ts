/**
 * Gemini's error envelope sent inside a stream, as a provider stream error.
 *
 * Gemini can answer a streamed call with HTTP 200 and then send its error body
 * as an SSE event: `{"error":{"code":503,"message":"…","status":"UNAVAILABLE"}}`.
 * `@ai-sdk/google`'s chat model checks each event against a schema whose fields
 * are all optional, so the envelope passes as an empty chunk, its `error` is
 * dropped, and the stream ends with the SDK's default finish. Nothing fails:
 * the call returns no content, or the text sent before the error, as a normal
 * end of turn.
 *
 * This middleware asks the model for its raw chunks, and turns a chunk that is
 * an error envelope into an `error` part marked by `createProviderStreamError`,
 * with the HTTP status the same failure would have had as a response. The
 * model stream (`stream.ts`) then fails the call with that status, so the
 * engine's retry and context-overflow handling, and the run's `run.error`,
 * treat it as they treat the HTTP error.
 *
 * Remove it once `@ai-sdk/google` reports the envelope itself (vercel/ai#24318):
 * the canary in `test/unit/google-stream-error.test.ts` fails when it does.
 * Until then the two cannot conflict, since the stream fails on the first
 * provider error.
 */

import type { LanguageModelV4Middleware, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createProviderStreamError, type ProviderStreamError } from "@ai-sdk/provider-utils";

/** The HTTP status for each `google.rpc.Code` name, as Google's APIs map them. */
const RPC_STATUS_HTTP: Record<string, number> = {
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

/**
 * The provider stream error for a raw chunk that is Gemini's error envelope, or
 * `undefined` for any other chunk. The status is the envelope's `code`, else
 * its `status` name mapped to HTTP; with neither, the error carries no status.
 * Retryability follows the AI SDK's rule for an HTTP error (`APICallError`):
 * 408, 409, 429 and 5xx.
 */
export function googleStreamError(rawValue: unknown): ProviderStreamError | undefined {
  if (!isRecord(rawValue) || !isRecord(rawValue.error)) return undefined;
  const { code, message, status } = rawValue.error;
  const name = typeof status === "string" ? status : undefined;
  if (typeof message !== "string" && typeof code !== "number" && name === undefined) {
    return undefined;
  }
  const statusCode = isHttpStatus(code) ? code : name ? RPC_STATUS_HTTP[name] : undefined;
  const isRetryable =
    statusCode === undefined
      ? undefined
      : statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
  return createProviderStreamError({
    message: typeof message === "string" && message ? message : "Gemini reported an error",
    type: name,
    code: typeof code === "number" ? code : undefined,
    statusCode,
    isRetryable,
    data: rawValue,
  });
}

/**
 * Wraps Google's chat model so an error envelope inside its stream becomes a
 * provider stream error. Raw chunks are requested for the check and passed on
 * only to a caller that asked for them.
 */
export const googleStreamErrorMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapStream: async ({ model, params }) => {
    const result = await model.doStream({ ...params, includeRawChunks: true });
    const forwardRaw = params.includeRawChunks === true;
    const stream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type !== "raw") {
            controller.enqueue(part);
            return;
          }
          if (forwardRaw) controller.enqueue(part);
          const error = googleStreamError(part.rawValue);
          if (error) controller.enqueue({ type: "error", error });
        },
      }),
    );
    return { ...result, stream };
  },
};
