const PDF_MIME = "application/pdf";

const ANTHROPIC_PDF_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
const OPENAI_PDF_REQUEST_LIMIT_BYTES = 50 * 1024 * 1024;

export interface FileInputPolicy {
  pdf?: {
    maxFileBytes: number;
    maxTotalBytes: number;
  };
}

export function getFileInputPolicy(modelString: string): FileInputPolicy {
  const { provider, modelId } = parseResolvedModelString(modelString);

  if (provider === "anthropic" && modelId.startsWith("claude-")) {
    return {
      pdf: {
        maxFileBytes: ANTHROPIC_PDF_REQUEST_LIMIT_BYTES,
        maxTotalBytes: ANTHROPIC_PDF_REQUEST_LIMIT_BYTES,
      },
    };
  }

  if (provider === "openai" && supportsOpenAiPdfInput(modelId)) {
    return {
      pdf: {
        maxFileBytes: OPENAI_PDF_REQUEST_LIMIT_BYTES,
        maxTotalBytes: OPENAI_PDF_REQUEST_LIMIT_BYTES,
      },
    };
  }

  return {};
}

export function acceptsFileMime(policy: FileInputPolicy, mimeType: string): boolean {
  return mimeType === PDF_MIME && Boolean(policy.pdf);
}

function parseResolvedModelString(modelString: string): { provider: string; modelId: string } {
  const idx = modelString.indexOf(":");
  if (idx === -1) return { provider: "anthropic", modelId: modelString };
  return { provider: modelString.slice(0, idx), modelId: modelString.slice(idx + 1) };
}

function supportsOpenAiPdfInput(modelId: string): boolean {
  return modelId.startsWith("gpt-4o") || modelId.startsWith("gpt-5");
}

export const FILE_INPUT_MIMES = {
  pdf: PDF_MIME,
} as const;
