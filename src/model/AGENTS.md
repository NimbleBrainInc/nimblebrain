# Model providers

- **`@ai-sdk/google` drops an error Gemini sends inside the stream** (vercel/ai#24318), so a failed call would end as a silent success; `google-stream-error.ts`, wrapped on every `google:` model in `registry.ts`, raises it as a provider stream error until the provider does, and its canary test fails once the middleware can be deleted.
