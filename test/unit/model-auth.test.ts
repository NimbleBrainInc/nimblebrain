import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError, wrapLanguageModel } from "ai";
import { ModelAuthError, modelAuthMiddleware } from "../../src/model/model-auth.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const CALL: LanguageModelV4CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
};

function apiError(statusCode: number, data?: unknown): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    statusCode,
    data,
  });
}

/** Gemini's answer to a key it does not accept. */
const GEMINI_KEY_INVALID = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
  },
};

/** The error a wrapped model's stream and generate calls fail with when the client throws `thrown`. */
async function failures(provider: string, thrown: unknown): Promise<[unknown, unknown]> {
  const model = wrapLanguageModel({
    model: createMockModel(() => {
      throw thrown;
    }),
    middleware: modelAuthMiddleware(provider),
  });
  return [
    await model.doStream(CALL).catch((e: unknown) => e),
    await model.doGenerate(CALL).catch((e: unknown) => e),
  ];
}

describe("modelAuthMiddleware", () => {
  it("fails a rejected key (401) as ModelAuthError naming the provider", async () => {
    const cause = apiError(401);
    for (const err of await failures("anthropic", cause)) {
      expect(err).toBeInstanceOf(ModelAuthError);
      expect((err as ModelAuthError).code).toBe("model_auth_failed");
      expect((err as ModelAuthError).message).toBe(
        "The model provider has no valid API key. Set one for anthropic and restart NimbleBrain.",
      );
      expect((err as ModelAuthError).cause).toBe(cause);
    }
  });

  // A client with no key throws before it sends anything, so no 401 arrives.
  it("fails a missing key (LoadAPIKeyError) as ModelAuthError", async () => {
    const cause = new LoadAPIKeyError({ message: "OpenAI API key is missing." });
    for (const err of await failures("openai", cause)) {
      expect(err).toBeInstanceOf(ModelAuthError);
      expect((err as Error).message).toContain("Set one for openai");
      expect((err as Error).cause).toBe(cause);
    }
  });

  it("fails Gemini's 400 API_KEY_INVALID as ModelAuthError", async () => {
    for (const err of await failures("google", apiError(400, GEMINI_KEY_INVALID))) {
      expect(err).toBeInstanceOf(ModelAuthError);
      expect((err as Error).message).toContain("Set one for google");
    }
  });

  it("passes every other failure through unchanged", async () => {
    const cases: Array<[string, unknown]> = [
      ["anthropic", apiError(500)],
      ["anthropic", apiError(429)],
      [
        "google",
        apiError(400, { error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } }),
      ],
      ["anthropic", apiError(400, GEMINI_KEY_INVALID)],
    ];
    for (const [provider, cause] of cases) {
      for (const err of await failures(provider, cause)) expect(err).toBe(cause);
    }
  });
});
