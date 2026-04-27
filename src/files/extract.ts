import mammoth from "mammoth";
import { extractText as extractPdfText } from "unpdf";
import * as XLSX from "xlsx";

/**
 * Extract text from a file buffer based on MIME type.
 * Returns null for unsupported types or on extraction failure.
 */
export async function extractText(
  data: Buffer,
  mimeType: string,
  maxSize: number = 204_800,
): Promise<{ text: string; truncated: boolean } | null> {
  // Normalize: callers may pass `text/plain;charset=utf-8` from a
  // browser upload. Exact-Set / equality checks against the raw value
  // silently miss otherwise.
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  try {
    if (isTextMime(bare)) {
      return truncate(data.toString("utf-8"), maxSize);
    }

    if (bare === "application/pdf") {
      return await extractPdf(data, maxSize);
    }

    if (bare === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return await extractDocx(data, maxSize);
    }

    if (bare === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return extractXlsx(data, maxSize);
    }

    // Images and everything else: not extractable
    return null;
  } catch (err) {
    console.error(`[files/extract] Failed to extract text from ${mimeType}:`, err);
    return null;
  }
}

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

function isTextMime(mimeType: string): boolean {
  return TEXT_MIME_TYPES.has(mimeType);
}

function truncate(text: string, maxSize: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxSize) {
    return { text, truncated: false };
  }
  // Truncate by encoding to buffer and slicing
  const buf = Buffer.from(text, "utf-8");
  let truncated = buf.subarray(0, maxSize).toString("utf-8");
  // Fix potential partial multi-byte character at the end
  if (truncated.endsWith("\uFFFD")) {
    truncated = truncated.slice(0, -1);
  }
  const kb = Math.round(maxSize / 1024);
  truncated += `\n[... truncated at ${kb} KB — use files__read for full content]`;
  return { text: truncated, truncated: true };
}

async function extractPdf(
  data: Buffer,
  maxSize: number,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const result = await extractPdfText(new Uint8Array(data));
    const text =
      result.totalPages > 1
        ? result.text.map((page, i) => `--- Page ${i + 1} ---\n${page}`).join("\n\n")
        : (result.text[0] ?? "");
    return truncate(text, maxSize);
  } catch (err) {
    console.error("[files/extract] PDF extraction failed:", err);
    return null;
  }
}

async function extractDocx(
  data: Buffer,
  maxSize: number,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: mammoth types don't expose convertToMarkdown
    const result = await (mammoth as any).convertToMarkdown({ buffer: data });
    return truncate(result.value, maxSize);
  } catch (err) {
    console.error("[files/extract] DOCX extraction failed:", err);
    return null;
  }
}

function extractXlsx(data: Buffer, maxSize: number): { text: string; truncated: boolean } | null {
  try {
    // Validate XLSX magic bytes (PK zip signature)
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      return null;
    }
    const workbook = XLSX.read(data, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return null;
    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) return null;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return truncate(csv, maxSize);
  } catch (err) {
    console.error("[files/extract] XLSX extraction failed:", err);
    return null;
  }
}
