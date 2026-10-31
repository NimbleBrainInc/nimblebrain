import { afterEach, describe, expect, it } from "bun:test";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { isProviderStreamError } from "@ai-sdk/provider-utils";
import { withRetry } from "../../src/engine/retry.ts";
import { buildModelResolver } from "../../src/model/registry.ts";
import { callModel, ModelStreamError } from "../../src/model/stream.ts";
import { fakeFetch } from "../helpers/fake-fetch.ts";

const prompt: LanguageModelV4CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

const textChunk = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
});
const stopChunk = {
  candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};
const unavailable = {
  error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" },
};

/** One SSE response body per call, in order, and the URLs the calls went to. */
function sseResponses(...bodies: unknown[][]): {
  fetch: typeof fetch;
  calls: () => number;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch = fakeFetch(async (input) => {
    const events = bodies[Math.min(urls.length, bodies.length - 1)] ?? [];
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { fetch, calls: () => urls.length, urls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A `google:` model as the runtime resolves it with its own key, calling `stub` for its requests. */
function resolvedGoogleModel(stub: typeof fetch) {
  globalThis.fetch = stub;
  return buildModelResolver({ providers: { google: { apiKey: "test-key" } } })(
    "google:gemini-2.5-flash",
  );
}

/** Every part of a model stream, read to its end. */
async function readParts(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    parts.push(next.value);
  }
  return parts;
}

async function rejection(promise: Promise<unknown>): Promise<ModelStreamError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelStreamError);
    return err as ModelStreamError;
  }
  throw new Error("expected the call to fail");
}

describe("callModel + google — an error envelope sent inside the stream", () => {
  it("test_error_before_output_is_retried_then_reported_with_its_status", async () => {
    const { fetch, calls } = sseResponses([unavailable]);
    const model = resolvedGoogleModel(fetch);

    const err = await rejection(withRetry(() => callModel(model, prompt, () => {}), 2, 0));

    expect(calls()).toBe(3);
    expect(err.statusCode).toBe(503);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toBe("The model is overloaded.");
  });

  it("test_error_before_output_then_success_returns_the_retried_reply", async () => {
    const { fetch, calls } = sseResponses([unavailable], [textChunk("recovered"), stopChunk]);
    const model = resolvedGoogleModel(fetch);

    const result = await withRetry(() => callModel(model, prompt, () => {}), 3, 0);

    expect(calls()).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(result.finishReason.unified).toBe("stop");
  });

  it("test_error_after_output_fails_the_call_without_a_retry", async () => {
    const { fetch, calls } = sseResponses([textChunk("Hello"), unavailable]);
    const model = resolvedGoogleModel(fetch);
    const deltas: string[] = [];

    const err = await rejection(
      withRetry(() => callModel(model, prompt, (d) => deltas.push(d)), 3, 0),
    );

    expect(calls()).toBe(1);
    expect(deltas).toEqual(["Hello"]);
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(false);
  });

  it("test_error_without_code_takes_the_status_of_its_name", async () => {
    const exhausted = { error: { code: null, message: "Quota", status: "RESOURCE_EXHAUSTED" } };
    const model = resolvedGoogleModel(sseResponses([exhausted]).fetch);

    const err = await rejection(callModel(model, prompt, () => {}));

    expect(err.statusCode).toBe(429);
    expect(err.isRetryable).toBe(true);
  });

  it("test_non_retryable_error_is_reported_with_its_status_after_one_attempt", async () => {
    const denied = {
      error: { code: 403, message: "Permission denied.", status: "PERMISSION_DENIED" },
    };
    const { fetch, calls } = sseResponses([denied]);
    const model = resolvedGoogleModel(fetch);

    const err = await rejection(withRetry(() => callModel(model, prompt, () => {}), 3, 0));

    expect(calls()).toBe(1);
    expect(err.statusCode).toBe(403);
    expect(err.isRetryable).toBe(false);
  });

  it("test_unparseable_chunk_before_output_fails_the_call_without_a_status", async () => {
    const model = resolvedGoogleModel(sseResponses([{ candidates: "nope" }]).fetch);

    const err = await rejection(callModel(model, prompt, () => {}));

    expect(isProviderStreamError(err.cause)).toBe(false);
    expect(err.statusCode).toBeUndefined();
    expect(err.isRetryable).toBeUndefined();
  });

  it("test_clean_stream_passes_no_raw_parts_on", async () => {
    const model = resolvedGoogleModel(sseResponses([textChunk("Hello"), stopChunk]).fetch);

    const { stream } = await model.doStream(prompt);
    const types: string[] = [];
    for (const part of await readParts(stream)) {
      types.push(part.type);
    }

    expect(types).not.toContain("raw");
    expect(types).not.toContain("error");
    expect(types).toContain("text-delta");
    expect(types.at(-1)).toBe("finish");
  });

  it("test_requested_raw_chunks_are_passed_on", async () => {
    const model = resolvedGoogleModel(sseResponses([textChunk("Hello"), stopChunk]).fetch);

    const { stream } = await model.doStream({ ...prompt, includeRawChunks: true });
    const raw: unknown[] = [];
    for (const part of await readParts(stream)) {
      if (part.type === "raw") raw.push(part.rawValue);
    }

    expect(raw).toEqual([textChunk("Hello"), stopChunk]);
  });

  it("test_error_through_the_model_gateway_is_reported_with_its_status", async () => {
    const { fetch, urls } = sseResponses([unavailable]);
    const model = buildModelResolver(
      {},
      { url: "http://model-gateway.test", fetch },
    )("google:gemini-2.5-flash");

    const err = await rejection(callModel(model, prompt, () => {}));

    expect(urls[0]).toStartWith("http://model-gateway.test/google/v1beta/");
    expect(err.statusCode).toBe(503);
    expect(err.isRetryable).toBe(true);
  });
});

// Canary: `@ai-sdk/google` drops the error envelope today (vercel/ai#24318),
// which is why src/model/google-stream-error.ts exists. When this fails, the
// provider reports the envelope itself: delete that middleware and this test.
describe("@ai-sdk/google — the error envelope inside the stream (canary)", () => {
  it("test_bare_provider_emits_no_error_part_for_the_envelope", async () => {
    const model = createGoogleGenerativeAI({
      apiKey: "test-key",
      fetch: sseResponses([unavailable]).fetch,
    }).languageModel("gemini-2.5-flash");

    const { stream } = await model.doStream(prompt);
    const errors: unknown[] = [];
    for (const part of await readParts(stream)) {
      if (part.type === "error") errors.push(part.error);
    }

    expect(errors.some(isProviderStreamError)).toBe(false);
    expect(errors).toEqual([]);
  });
});
