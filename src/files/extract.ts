import mammoth from "mammoth";
import { type CellValue, readSheet } from "read-excel-file/node";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { log } from "../observability/log.ts";
import { isTextMime } from "./mime.ts";

export interface ExtractedPdfPage {
  page: number;
  text: string;
  truncated: boolean;
  empty: boolean;
}

export interface ExtractPdfPagesResult {
  totalPages: number;
  pages: ExtractedPdfPage[];
  missingPages: number[];
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfPageProxy {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy?: () => Promise<void> | void;
}

/**
 * Truncation suffix used by callers that route extracted text into the
 * rehydrate fallback path (i.e. the model already has the `files__read`
 * tool surfaced separately, so the suffix should not nudge it to call).
 * Centralised so ingest-time sidecar population and rehydrate-time live
 * extraction produce byte-identical text — required for the FileStore
 * extracted-text cache to be valid across paths.
 */
export const REHYDRATE_TRUNCATED_SUFFIX = (kb: number): string => `\n[... truncated at ${kb} KB]`;

/**
 * Extract text from a file buffer based on MIME type.
 * Returns null for unsupported types or on extraction failure.
 */
export async function extractText(
  data: Buffer,
  mimeType: string,
  maxSize: number = 204_800,
  options: { truncatedSuffix?: (kb: number) => string } = {},
): Promise<{ text: string; truncated: boolean } | null> {
  // Normalize: callers may pass `text/plain;charset=utf-8` from a
  // browser upload. Exact-Set / equality checks against the raw value
  // silently miss otherwise.
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  try {
    if (isTextMime(bare)) {
      return truncate(data.toString("utf-8"), maxSize, options);
    }

    if (bare === "application/pdf") {
      return await extractPdf(data, maxSize, options);
    }

    if (bare === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return await extractDocx(data, maxSize, options);
    }

    if (bare === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return await extractXlsx(data, maxSize, options);
    }

    // Images and everything else: not extractable
    return null;
  } catch (err) {
    log.error(`[files/extract] Failed to extract text from ${mimeType}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Extract text from specific 1-based PDF pages without materialising every
 * page's text into the tool result. The caller still provides the PDF bytes,
 * but extraction work and output are bounded by the requested page count.
 */
export async function extractPdfPages(
  data: Buffer,
  pages: number[],
  options: { maxPageTextSize?: number } = {},
): Promise<ExtractPdfPagesResult | null> {
  const maxPageTextSize = options.maxPageTextSize ?? 20_480;
  let pdf: PdfDocumentProxy | null = null;

  try {
    pdf = (await getDocumentProxy(new Uint8Array(data))) as PdfDocumentProxy;
    const resultPages: ExtractedPdfPage[] = [];
    const missingPages: number[] = [];

    for (const page of pages) {
      if (page < 1 || page > pdf.numPages) {
        missingPages.push(page);
        continue;
      }

      const pageProxy = await pdf.getPage(page);
      const content = await pageProxy.getTextContent();
      const rawText = content.items
        .filter((item) => item.str != null)
        .map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`)
        .join("");
      const extracted = truncate(rawText, maxPageTextSize, {
        truncatedSuffix: (kb) => `\n[... page text truncated at ${kb} KB]`,
      });

      resultPages.push({
        page,
        text: extracted.text,
        truncated: extracted.truncated,
        empty: rawText.trim().length === 0,
      });
    }

    return { totalPages: pdf.numPages, pages: resultPages, missingPages };
  } catch (err) {
    log.error("[files/extract] PDF page extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await pdf?.destroy?.();
  }
}

function truncate(
  text: string,
  maxSize: number,
  options: { truncatedSuffix?: (kb: number) => string } = {},
): { text: string; truncated: boolean } {
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
  truncated +=
    options.truncatedSuffix?.(kb) ??
    `\n[... truncated at ${kb} KB — use files__read for full content]`;
  return { text: truncated, truncated: true };
}

async function extractPdf(
  data: Buffer,
  maxSize: number,
  options: { truncatedSuffix?: (kb: number) => string } = {},
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const result = await extractPdfText(new Uint8Array(data));
    const text =
      result.totalPages > 1
        ? result.text.map((page, i) => `--- Page ${i + 1} ---\n${page}`).join("\n\n")
        : (result.text[0] ?? "");
    return truncate(text, maxSize, options);
  } catch (err) {
    log.error("[files/extract] PDF extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function extractDocx(
  data: Buffer,
  maxSize: number,
  options: { truncatedSuffix?: (kb: number) => string } = {},
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: mammoth types don't expose convertToMarkdown
    const result = await (mammoth as any).convertToMarkdown({ buffer: data });
    return truncate(result.value, maxSize, options);
  } catch (err) {
    log.error("[files/extract] DOCX extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Excel serial 0. A time-only cell has a serial below 1, so it lands here. */
const EXCEL_EPOCH_DATE = "1899-12-30";

/**
 * Render a date-family cell.
 *
 * The parser returns a `Date` for every date-family number format — date-only,
 * datetime, time-of-day and elapsed-time alike — so the format cannot be read
 * back off the value and the shape has to be inferred from the instant itself:
 *
 * - a time-only cell carries a serial below 1, so its date part is the Excel
 *   epoch and only the clock time is real
 * - a whole-day serial lands exactly on midnight, so only the date is real
 * - anything else is a genuine datetime and both halves are real
 *
 * Emitting the full ISO instant for all three would put a fabricated
 * `1899-12-30` in front of every timesheet entry; slicing to the date alone
 * would silently drop the time from every datetime.
 *
 * The serial→ms conversion floors, so a 14:30 cell arrives as 14:29:59.999 and
 * has to be rounded to the second before anything is read off it.
 */
function renderDate(value: Date): string {
  const iso = new Date(Math.round(value.getTime() / 1000) * 1000).toISOString();
  const [date, time] = [iso.slice(0, 10), iso.slice(11, 19)];
  if (date === EXCEL_EPOCH_DATE) return time;
  return time === "00:00:00" ? date : `${date} ${time}`;
}

/**
 * Render one parsed cell as a CSV field.
 *
 * The parser hands back real JS values (`string | number | boolean | Date |
 * null`) rather than Excel's display text, so the rendering is ours to choose.
 * Dates become ISO-8601 because the consumer is a model with no locale to
 * disambiguate Excel's `1/14/26`, and the parser reads a sheet's
 * timezone-naive serial as an absolute UTC instant, so the UTC components are
 * the sheet's own wall-clock values on any runner.
 */
function toCsvCell(value: CellValue | null): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? renderDate(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function extractXlsx(
  data: Buffer,
  maxSize: number,
  options: { truncatedSuffix?: (kb: number) => string } = {},
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    // Validate XLSX magic bytes (PK zip signature)
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      return null;
    }
    // Only the first sheet is extracted. `readSheet` still unzips the archive
    // and parses the workbook's shared strings and styles — it narrows only the
    // sheet-data XML parse, not the whole read.
    const rows = await readSheet(data, 1);
    if (rows.length === 0) return null;
    const csv = rows.map((row) => row.map(toCsvCell).join(",")).join("\n");
    return truncate(csv, maxSize, options);
  } catch (err) {
    log.error("[files/extract] XLSX extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
