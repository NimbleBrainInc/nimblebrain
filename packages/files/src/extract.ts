/**
 * Text extraction, in this process (CONTRACT.md §8): plain text as it stands, PDF by page,
 * DOCX as Markdown, XLSX's first sheet as CSV. Anything else has no text.
 *
 * Extraction is bounded by the text kept, not by the input. Every budget is fixed here, and
 * a body whose extraction would pass one is refused before it is parsed (`null`, the same as
 * an unreadable body), never parsed in full and then cut: the parsers inflate and hold the
 * whole document, so the output bound alone bounds neither memory nor time. Each budget was
 * measured against its parser's amplification (peak memory per byte of XML). A refused or
 * failed extraction is a body with no text.
 */

import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { bareType, DOCX, isPlainText, PDF, XLSX as XLSX_MIME } from "./mime.ts";

/** The most UTF-8 bytes of text one extraction keeps (the contract's 1 MiB, CONTRACT.md §7). */
export const TEXT_BOUND = 1024 * 1024;

/**
 * The text an OOXML parse budget is sized for. A DOCX or XLSX is held to the work its parser
 * does for this much text, whatever the caller then keeps of it.
 */
const OOXML_WORK_BASIS = 204_800;
/** XML every package carries whatever its length (styles, theme, settings, relationships). */
const OOXML_BASE_XML_BYTES = 256 * 1024;
/** DOCX: mammoth holds about 185 bytes per byte of document XML at peak. */
const DOCX_XML_BUDGET = OOXML_BASE_XML_BYTES + 16 * OOXML_WORK_BASIS;
/** XLSX: SheetJS holds about 11 bytes per byte of sheet XML at peak. */
const XLSX_XML_BUDGET = OOXML_BASE_XML_BYTES + 128 * OOXML_WORK_BASIS;
/**
 * Every entry of a DOCX/XLSX, media included, may be inflated: mammoth inlines each
 * referenced image as a base64 data URI. Real media is already compressed, so its declared
 * size is close to its stored size, which the upload limit bounds.
 */
const OOXML_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const OOXML_MAX_ENTRIES = 10_000;
/**
 * A PDF stops at the page where its text passes the bound. These cap the pages read when
 * the pages hold little or no text, and the time spent: pdf.js's cost per page grows with
 * the document's page count, so a page count alone does not bound the time.
 */
const PDF_MAX_PAGES = 2_000;
const PDF_TIME_BUDGET_MS = 5_000;

// The parsers are imported on first use, not at load: together they are most of the server's
// start time, and a server that extracts nothing (every boot, every test) never needs them.
const loadPdf = () => import("unpdf");
const loadMammoth = async () => (await import("mammoth")).default;
const loadXlsx = () => import("@e965/xlsx");

export interface Extracted {
  text: string;
  truncated: boolean;
}

export interface ExtractedPage {
  page: number;
  text: string;
  truncated: boolean;
  empty: boolean;
}

export interface ExtractedPages {
  totalPages: number;
  pages: ExtractedPage[];
  missingPages: number[];
}

function logFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`nb-files: ${what} failed: ${detail}\n`);
}

/**
 * One extraction runs at a time per process, so peak memory does not multiply with
 * concurrent reads. Each extraction is bounded, so the wait behind one is bounded too.
 * Plain text skips the queue.
 */
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** `text` cut to at most `maxBytes` of UTF-8, at a character boundary. */
export function cutText(text: string, maxBytes: number): Extracted {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, "utf-8");
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to the start of a character.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

/**
 * The body's text, up to {@link TEXT_BOUND}, or null: a type with no text, a body refused
 * by a budget, or one that failed to parse.
 */
export async function extractText(data: Buffer, mimeType: string): Promise<Extracted | null> {
  const bare = bareType(mimeType);
  if (isPlainText(bare)) return cutText(data.toString("utf-8"), TEXT_BOUND);
  let extractor: (() => Promise<Extracted | null>) | null = null;
  if (bare === PDF) extractor = () => extractPdf(data);
  else if (bare === DOCX) extractor = () => extractDocx(data);
  else if (bare === XLSX_MIME) extractor = () => extractXlsx(data);
  if (!extractor) return null;
  const run = extractor;
  return oneAtATime(async () => {
    try {
      return await run();
    } catch (err) {
      logFailure(`extracting ${bare}`, err);
      return null;
    }
  });
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    cleanup?: () => unknown;
  }>;
  /** Destroying the loading task frees the document; the proxy has no `destroy` of its own. */
  loadingTask: { destroy(): Promise<void> };
}

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
 * Pages in order, stopping once the text passes the bound, so the work is bounded by the
 * text kept rather than the page count. A PDF that reaches its page or time budget first is
 * truncated there. pdf.js runs on this thread, so the loop yields between pages.
 */
async function extractPdf(data: Buffer): Promise<Extracted | null> {
  let pdf: PdfDocumentProxy | null = null;
  try {
    const { getDocumentProxy } = await loadPdf();
    pdf = (await getDocumentProxy(new Uint8Array(data))) as PdfDocumentProxy;
    const totalPages = pdf.numPages;
    const lastPage = Math.min(totalPages, PDF_MAX_PAGES);
    const deadline = performance.now() + PDF_TIME_BUDGET_MS;
    const parts: string[] = [];
    let bytes = 0;
    let read = 0;
    while (read < lastPage && bytes <= TEXT_BOUND && performance.now() < deadline) {
      read++;
      const pageText = await pdfPageText(pdf, read);
      const part =
        totalPages > 1 ? `${read > 1 ? "\n\n" : ""}--- Page ${read} ---\n${pageText}` : pageText;
      parts.push(part);
      bytes += Buffer.byteLength(part, "utf-8");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = cutText(parts.join(""), TEXT_BOUND);
    return read < totalPages ? { text: result.text, truncated: true } : result;
  } catch (err) {
    logFailure("extracting a PDF", err);
    return null;
  } finally {
    await pdf?.loadingTask.destroy();
  }
}

/**
 * The text of 1-based `pages` of a PDF, together at most `maxBytes`, or null when the
 * document cannot be read. A page past the end is listed in `missingPages`.
 */
export async function extractPdfPages(
  data: Buffer,
  pages: number[],
  maxBytes: number,
): Promise<ExtractedPages | null> {
  return oneAtATime(async () => {
    let pdf: PdfDocumentProxy | null = null;
    try {
      const { getDocumentProxy } = await loadPdf();
      pdf = (await getDocumentProxy(new Uint8Array(data))) as PdfDocumentProxy;
      const out: ExtractedPage[] = [];
      const missingPages: number[] = [];
      let left = maxBytes;
      for (const page of pages) {
        if (page < 1 || page > pdf.numPages) {
          missingPages.push(page);
          continue;
        }
        const raw = await pdfPageText(pdf, page);
        const cut = cutText(raw, left);
        left -= Buffer.byteLength(cut.text, "utf-8");
        out.push({ page, text: cut.text, truncated: cut.truncated, empty: raw.trim() === "" });
      }
      return { totalPages: pdf.numPages, pages: out, missingPages };
    } catch (err) {
      logFailure("extracting PDF pages", err);
      return null;
    } finally {
      await pdf?.loadingTask.destroy();
    }
  });
}

async function extractDocx(data: Buffer): Promise<Extracted | null> {
  if (await refuseOversized("DOCX", data, DOCX_XML_BUDGET)) return null;
  // mammoth exports `convertToMarkdown` beside `convertToHtml`, with the same signature, but
  // its type declarations name only the latter.
  const mammoth = await loadMammoth();
  const { convertToMarkdown } = mammoth as typeof mammoth & {
    convertToMarkdown: typeof mammoth.convertToHtml;
  };
  const result = await convertToMarkdown({ buffer: data });
  return cutText(result.value, TEXT_BOUND);
}

/**
 * The first sheet as CSV, each cell rendered through the number format the workbook
 * stores, so what comes out is what a spreadsheet shows.
 *
 * SECURITY: `@e965/xlsx` is SheetJS republished under another name, and advisories are
 * keyed to the name, so a clean `bun audit` says nothing about it. Its version is pinned
 * exact; watch SheetJS releases and bump it deliberately.
 */
async function extractXlsx(data: Buffer): Promise<Extracted | null> {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return null;
  if (await refuseOversized("XLSX", data, XLSX_XML_BUDGET)) return null;
  const XLSX = await loadXlsx();
  const workbook = XLSX.read(data, { type: "buffer", dense: true });
  const first = workbook.SheetNames[0];
  const sheet = first ? workbook.Sheets[first] : undefined;
  if (!sheet) return null;
  return cutText(XLSX.utils.sheet_to_csv(sheet), TEXT_BOUND);
}

async function refuseOversized(kind: string, data: Buffer, xmlBudget: number): Promise<boolean> {
  if (await ooxmlWithinBudget(data, xmlBudget)) return false;
  process.stderr.write(
    `nb-files: a ${kind} of ${data.length} bytes is not extracted: it passes the extraction budget\n`,
  );
  return true;
}

const inflateRawAsync = promisify(inflateRaw);

/**
 * True when a zip's central directory declares no more than `xmlBudget` uncompressed bytes
 * of XML parts and `OOXML_MAX_INFLATED_BYTES` in all, across at most `OOXML_MAX_ENTRIES`
 * entries, and every entry inflates to no more than its declared size.
 *
 * The declared sums are checked first, from the directory alone, so an archive that
 * declares too much costs nothing. The parsers do not stop at a declared size, so each entry
 * is then inflated once here with its declared size as the output limit. The directory must
 * fill the space between its offset and the end record, and the end record must end the
 * file, so every parser reads the same entries this one counted. A local size above the
 * directory's is refused too. ZIP64, multi-disk, malformed directories, and compression
 * methods other than stored and deflate are refused.
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

function findCentralDirectory(data: Buffer): CentralDirectory | null {
  if (data.length < EOCD_SIZE) return null;
  const searchFloor = Math.max(0, data.length - EOCD_SIZE - 0xffff);
  let eocd = -1;
  for (let i = data.length - EOCD_SIZE; i >= searchFloor; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  // A ZIP64 locator sits right before the end record.
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

function hasZip64Extra(data: Buffer, start: number, end: number): boolean {
  for (let p = start; p + 4 <= end; p += 4 + data.readUInt16LE(p + 2)) {
    if (data.readUInt16LE(p) === 0x0001) return true;
  }
  return false;
}
