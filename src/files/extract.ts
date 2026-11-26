import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import * as XLSX from "@e965/xlsx";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";
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
  cleanup?: () => unknown;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  /** Destroying the loading task frees the document; the proxy has no `destroy` of its own. */
  loadingTask: { destroy(): Promise<void> };
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

type ExtractOptions = { truncatedSuffix?: (kb: number) => string };
type Extracted = { text: string; truncated: boolean };

/**
 * Extraction work is bounded by the text the caller keeps, not by the input.
 *
 * Every budget below derives from `maxSize`, so a caller that keeps less text
 * also pays less. An input that would cost more than its budget is refused
 * before parsing (`null`, the same as an unreadable file), never parsed in full
 * and then truncated: the parsers inflate and hold the whole document, so the
 * output cap alone bounds neither memory nor event-loop time. Each budget was
 * measured against its parser's amplification (peak memory per byte of XML).
 */

/**
 * XML every package carries whatever its length (styles, theme, settings,
 * relationships), allowed on top of the per-output-byte budget.
 */
const OOXML_BASE_XML_BYTES = 256 * 1024;
/** DOCX: mammoth holds about 185 bytes per byte of document XML at peak. */
const DOCX_XML_BUDGET_PER_OUTPUT_BYTE = 16;
/** XLSX: SheetJS holds about 11 bytes per byte of sheet XML at peak. */
const XLSX_XML_BUDGET_PER_OUTPUT_BYTE = 128;
/**
 * Every entry of a DOCX/XLSX, media included, may be inflated: mammoth inlines
 * each referenced image as a base64 data URI. Real media is already compressed,
 * so its declared size is close to its stored size, which the upload cap bounds.
 */
const OOXML_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const OOXML_MAX_ENTRIES = 10_000;
/**
 * A PDF stops at the page where its text passes `maxSize`. These cap the pages
 * read when the pages hold little or no text, and the time spent: pdf.js's cost
 * per page grows with the document's page count (about 3 ms a page in a flat
 * 20,000-page tree), so a page count alone does not bound the time.
 */
const PDF_MAX_PAGES = 2_000;
const PDF_TIME_BUDGET_MS = 5_000;

/**
 * One extraction runs at a time per process, so peak memory does not multiply
 * with concurrent uploads and tool calls. Each extraction is bounded, so the
 * wait behind one is bounded too. Plain-text decoding skips the queue.
 */
let extractionQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = extractionQueue.then(run);
  extractionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Extract text from a file buffer based on MIME type.
 * Returns null for unsupported types, on extraction failure, and for a
 * document too large to extract within the budget `maxSize` sets.
 */
export async function extractText(
  data: Buffer,
  mimeType: string,
  maxSize: number = 204_800,
  options: ExtractOptions = {},
): Promise<Extracted | null> {
  // Normalize: callers may pass `text/plain;charset=utf-8` from a
  // browser upload. Exact-Set / equality checks against the raw value
  // silently miss otherwise.
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (isTextMime(bare)) {
    return truncate(data.toString("utf-8"), maxSize, options);
  }

  let extractor: (() => Promise<Extracted | null>) | null = null;
  if (bare === "application/pdf") {
    extractor = () => extractPdf(data, maxSize, options);
  } else if (bare === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    extractor = () => extractDocx(data, maxSize, options);
  } else if (bare === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    extractor = () => extractXlsx(data, maxSize, options);
  }
  // Images and everything else: not extractable
  if (!extractor) return null;

  const run = extractor;
  return oneAtATime(async () => {
    try {
      return await run();
    } catch (err) {
      log.error(`[files/extract] Failed to extract text from ${mimeType}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });
}

const inflateRawAsync = promisify(inflateRaw);

/**
 * True when a zip's central directory declares no more than `xmlBudget`
 * uncompressed bytes of XML parts and `OOXML_MAX_INFLATED_BYTES` in all,
 * across at most `OOXML_MAX_ENTRIES` entries, and every entry inflates to no
 * more than its declared size.
 *
 * The declared sums are checked first, from the directory alone, so an archive
 * that declares too much costs nothing. The parsers do not stop at a declared
 * size (they inflate an entry in full and compare afterwards), so each entry is
 * then inflated once here with its declared size as the output limit; the
 * inflate stops at that limit, which the sums above bound. The directory must
 * fill the space between its offset and the end record, and the end record must
 * end the file, so every parser reads the same entries this one counted. A
 * parser may size its output buffer from the local header, so a local size
 * above the directory's is refused too. ZIP64 (in the end records or an extra
 * field), multi-disk, malformed directories, and compression methods other than
 * stored and deflate are refused.
 */
async function ooxmlWithinBudget(data: Buffer, xmlBudget: number): Promise<boolean> {
  const directory = findCentralDirectory(data);
  if (!directory) return false;
  const entries = centralEntries(data, directory);
  if (!entries) return false;
  let xml = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.xml) xml += entry.uncompressed;
    total += entry.uncompressed;
  }
  if (xml > xmlBudget || total > OOXML_MAX_INFLATED_BYTES) return false;
  for (const entry of entries) {
    if (!(await inflatesWithinDeclared(data, entry))) return false;
  }
  return true;
}

interface CentralDirectory {
  offset: number;
  end: number;
  entries: number;
}

interface CentralEntry {
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
  xml: boolean;
}

const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/** Locate the central directory from the end-of-central-directory record. */
function findCentralDirectory(data: Buffer): CentralDirectory | null {
  const searchFloor = Math.max(0, data.length - EOCD_SIZE - 0xffff);
  let eocd = -1;
  for (let i = data.length - EOCD_SIZE; i >= searchFloor; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  // A ZIP64 locator sits right before the EOCD.
  if (eocd >= 20 && data.readUInt32LE(eocd - 20) === 0x07064b50) return null;
  if (eocd + EOCD_SIZE + data.readUInt16LE(eocd + 20) !== data.length) return null;
  const multiDisk = data.readUInt16LE(eocd + 4) !== 0 || data.readUInt16LE(eocd + 6) !== 0;
  const entries = data.readUInt16LE(eocd + 10);
  const size = data.readUInt32LE(eocd + 12);
  const offset = data.readUInt32LE(eocd + 16);
  if (multiDisk || entries !== data.readUInt16LE(eocd + 8) || entries > OOXML_MAX_ENTRIES) {
    return null;
  }
  if (offset + size !== eocd) return null;
  return { offset, end: eocd, entries };
}

/** The directory's entries, which must fill it exactly. */
function centralEntries(data: Buffer, directory: CentralDirectory): CentralEntry[] | null {
  const entries: CentralEntry[] = [];
  let p = directory.offset;
  for (let i = 0; i < directory.entries; i++) {
    if (p + CENTRAL_HEADER_SIZE > directory.end || data.readUInt32LE(p) !== 0x02014b50) {
      return null;
    }
    const compressed = data.readUInt32LE(p + 20);
    const uncompressed = data.readUInt32LE(p + 24);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) return null;
    const nameStart = p + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + data.readUInt16LE(p + 28);
    const extraEnd = nameEnd + data.readUInt16LE(p + 30);
    const next = extraEnd + data.readUInt16LE(p + 32);
    if (next > directory.end || hasZip64Extra(data, nameEnd, extraEnd)) return null;
    const name = data.toString("latin1", nameStart, nameEnd).toLowerCase();
    entries.push({
      method: data.readUInt16LE(p + 10),
      compressed,
      uncompressed,
      localOffset: data.readUInt32LE(p + 42),
      xml: name.endsWith(".xml") || name.endsWith(".rels") || name.endsWith(".vml"),
    });
    p = next;
  }
  return p === directory.end ? entries : null;
}

/**
 * True when the entry's data, read from its local header the way the parsers
 * read it, yields no more than the directory declares. A deflate stream ends
 * itself, so inflating from the data's start to the end of the file yields what
 * any parser gets from it.
 */
async function inflatesWithinDeclared(data: Buffer, entry: CentralEntry): Promise<boolean> {
  const local = entry.localOffset;
  if (local + LOCAL_HEADER_SIZE > data.length || data.readUInt32LE(local) !== 0x04034b50) {
    return false;
  }
  if (data.readUInt16LE(local + 8) !== entry.method) return false;
  if (data.readUInt32LE(local + 22) > entry.uncompressed) return false;
  const extra = local + LOCAL_HEADER_SIZE + data.readUInt16LE(local + 26);
  const start = extra + data.readUInt16LE(local + 28);
  if (start > data.length || hasZip64Extra(data, extra, start)) return false;
  if (entry.method === 0) {
    return (
      entry.compressed <= entry.uncompressed && data.readUInt32LE(local + 18) <= entry.uncompressed
    );
  }
  if (entry.method !== 8) return false;
  try {
    const out = await inflateRawAsync(data.subarray(start), {
      maxOutputLength: Math.max(1, entry.uncompressed),
    });
    return out.length <= entry.uncompressed;
  } catch {
    return false;
  }
}

/**
 * True when the extra field in `data[start, end)` holds a ZIP64 record, whose
 * sizes a parser reads in place of the header's.
 */
function hasZip64Extra(data: Buffer, start: number, end: number): boolean {
  for (let p = start; p + 4 <= end; p += 4 + data.readUInt16LE(p + 2)) {
    if (data.readUInt16LE(p) === 0x0001) return true;
  }
  return false;
}

async function refuseOversized(kind: string, data: Buffer, xmlBudget: number): Promise<boolean> {
  if (await ooxmlWithinBudget(data, xmlBudget)) return false;
  log.info(`[files/extract] ${kind} not extracted: its size exceeds the extraction budget`, {
    bytes: data.length,
    xmlBudget,
  });
  return true;
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

      const rawText = await pdfPageText(pdf, page);
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
    await pdf?.loadingTask.destroy();
  }
}

function truncate(text: string, maxSize: number, options: ExtractOptions = {}): Extracted {
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

/** One page's text, joined the way unpdf's `extractText` joins it. */
async function pdfPageText(pdf: PdfDocumentProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  page.cleanup?.();
  return content.items
    .filter((item) => item.str != null)
    .map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`)
    .join("");
}

/**
 * Read pages in order and stop once the text passes `maxSize`, so the work is
 * bounded by the text kept rather than the page count. The text up to that
 * point, and so the truncated result, is byte-identical to joining every page:
 * PDF sidecars written from either are interchangeable. A PDF that reaches
 * `PDF_MAX_PAGES` or `PDF_TIME_BUDGET_MS` first ends with a notice naming the
 * pages read.
 *
 * pdf.js runs on this thread, so the loop yields to the event loop between
 * pages: one long PDF never holds the server for more than a page.
 */
async function extractPdf(
  data: Buffer,
  maxSize: number,
  options: ExtractOptions = {},
): Promise<Extracted | null> {
  let pdf: PdfDocumentProxy | null = null;
  try {
    pdf = (await getDocumentProxy(new Uint8Array(data))) as PdfDocumentProxy;
    const totalPages = pdf.numPages;
    const lastPage = Math.min(totalPages, PDF_MAX_PAGES);
    const deadline = performance.now() + PDF_TIME_BUDGET_MS;
    const parts: string[] = [];
    let bytes = 0;
    let read = 0;
    while (read < lastPage && bytes <= maxSize && performance.now() < deadline) {
      read++;
      const pageText = await pdfPageText(pdf, read);
      const part =
        totalPages > 1 ? `${read > 1 ? "\n\n" : ""}--- Page ${read} ---\n${pageText}` : pageText;
      parts.push(part);
      bytes += Buffer.byteLength(part, "utf-8");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = truncate(parts.join(""), maxSize, options);
    if (!result.truncated && read < totalPages) {
      return {
        text: `${result.text}\n[... text of the first ${read} of ${totalPages} pages]`,
        truncated: true,
      };
    }
    return result;
  } catch (err) {
    log.error("[files/extract] PDF extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await pdf?.loadingTask.destroy();
  }
}

async function extractDocx(
  data: Buffer,
  maxSize: number,
  options: ExtractOptions = {},
): Promise<Extracted | null> {
  if (
    await refuseOversized(
      "DOCX",
      data,
      OOXML_BASE_XML_BYTES + DOCX_XML_BUDGET_PER_OUTPUT_BYTE * maxSize,
    )
  )
    return null;
  try {
    // mammoth exports `convertToMarkdown` beside `convertToHtml`, with the same
    // signature, but its type declarations name only the latter.
    const { convertToMarkdown } = mammoth as typeof mammoth & {
      convertToMarkdown: typeof mammoth.convertToHtml;
    };
    const result = await convertToMarkdown({ buffer: data });
    return truncate(result.value, maxSize, options);
  } catch (err) {
    log.error("[files/extract] DOCX extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Extract the first sheet as CSV.
 *
 * `sheet_to_csv` renders each cell through the number format the workbook
 * stores, so what comes out is what Excel shows: a percent keeps its `%`, a
 * currency keeps its symbol, an elapsed `[h]:mm:ss` cell keeps hours past 24,
 * and `#N/A` stays `#N/A`. Nothing here reconstructs a cell's meaning.
 *
 * SECURITY — this dependency has no advisory coverage, so watch it by hand.
 * `@e965/xlsx` is SheetJS republished under a different name, and advisories are
 * keyed to the name: GitHub lists five against `xlsx` and none against this one.
 * A clean `bun audit` therefore says nothing about whether this code is
 * vulnerable — a republish of a version carrying a known SheetJS CVE audits
 * clean too. Nothing automated will flag the next one. Watch sheetjs.com /
 * git.sheetjs.com for releases and bump deliberately; the version is pinned
 * exact so an incidental `bun update` cannot move it. Renaming back to `xlsx`
 * is not an escape: npm's `xlsx` stopped at 0.18.5 and is itself unpatched,
 * and a `cdn.sheetjs.com` tarball dependency is invisible to `bun audit` too.
 *
 * The whole sheet is parsed: the precheck bounds its XML, and a row cap would
 * count worksheet rows, not CSV rows, so it would drop a sheet whose data
 * starts below the cap.
 */
async function extractXlsx(
  data: Buffer,
  maxSize: number,
  options: ExtractOptions = {},
): Promise<Extracted | null> {
  try {
    // Validate XLSX magic bytes (PK zip signature)
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      return null;
    }
    if (
      await refuseOversized(
        "XLSX",
        data,
        OOXML_BASE_XML_BYTES + XLSX_XML_BUDGET_PER_OUTPUT_BYTE * maxSize,
      )
    )
      return null;
    const workbook = XLSX.read(data, { type: "buffer", dense: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return null;
    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) return null;
    return truncate(XLSX.utils.sheet_to_csv(sheet), maxSize, options);
  } catch (err) {
    log.error("[files/extract] XLSX extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
