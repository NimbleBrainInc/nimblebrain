import { getModelByString } from "./catalog.ts";

const PDF_MIME = "application/pdf";

// Per-provider PDF byte budgets. Per-file and per-request use the same
// value: we keep one knob until the catalog grows a budget field.
// Sources:
//   - Anthropic: 32 MB request total (including all inputs).
//   - OpenAI: 50 MB request total; per-file documented at 32 MB but the
//     platform's `maxFileSize` upload cap (26 MB default) is what bounds
//     per-file in practice.
//   - Other providers fall through to a conservative default.
const PROVIDER_PDF_LIMIT_BYTES: Record<string, number> = {
  anthropic: 32 * 1024 * 1024,
  openai: 50 * 1024 * 1024,
};
const DEFAULT_PDF_LIMIT_BYTES = 32 * 1024 * 1024;

export interface FileInputPolicy {
  pdf?: {
    maxFileBytes: number;
    maxTotalBytes: number;
  };
}

/**
 * Derive a provider-aware file-input policy for the resolved model from
 * the model catalog (`src/model/catalog-data.json`). PDF support is read
 * from `modalities.input` — one source of truth. Adding a new model or
 * provider via `bun run sync-models` automatically picks up here; no
 * second prefix list to keep in sync.
 */
export function getFileInputPolicy(modelString: string): FileInputPolicy {
  const model = getModelByString(modelString);
  if (!model) return {};
  if (!model.modalities.input.includes("pdf")) return {};
  const limit = PROVIDER_PDF_LIMIT_BYTES[model.provider] ?? DEFAULT_PDF_LIMIT_BYTES;
  return { pdf: { maxFileBytes: limit, maxTotalBytes: limit } };
}

export function acceptsFileMime(policy: FileInputPolicy, mimeType: string): boolean {
  return mimeType === PDF_MIME && Boolean(policy.pdf);
}

export const FILE_INPUT_MIMES = {
  pdf: PDF_MIME,
} as const;
