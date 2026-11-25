/**
 * A conversation file's summary, folded line by line: its header, title, preview, message
 * count, totals, and how many events it holds (its last `seq`).
 *
 * A conversation file is append-only, so a change to one is new lines at its end. A scan
 * keeps where it stopped, and a re-read resumes from there when the file is the one it
 * read (same inode, same line 1, not shorter); anything else is read again from the start.
 * That keeps a list refreshed during a long turn from re-parsing whole files.
 */

import { type FileHandle, open } from "node:fs/promises";
import {
  accumulateEventMetrics,
  type ConversationHeader,
  type ConversationMeta,
  type DerivedMetrics,
  emptyMetrics,
  extractText,
  metaOf,
  type ReadEvent,
} from "./display.ts";

/** Why a file is not a readable conversation. */
export class CorruptConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptConversationError";
  }
}

export interface Scan {
  header: ConversationHeader;
  /** The file's bytes through line 1, an owned copy, compared on resume. */
  line1: Buffer;
  ino: number;
  /** Bytes folded so far. */
  offset: number;
  /** The first user message's text. */
  preview: string;
  title: string | null;
  userMessages: number;
  runStarts: string[];
  runsWithResponse: Set<string>;
  metrics: DerivedMetrics;
  /** Event lines folded: the conversation's last `seq`. */
  events: number;
}

/** The summary a scan describes. */
export function summaryOf(scan: Scan): {
  meta: ConversationMeta;
  preview: string;
  messageCount: number;
} {
  const messageCount =
    scan.userMessages + scan.runStarts.filter((r) => scan.runsWithResponse.has(r)).length;
  return {
    meta: metaOf(scan.header, scan.metrics, scan.title),
    preview: scan.preview,
    messageCount,
  };
}

/**
 * Whether a parsed line is an event: an object with a string `ts` and a string `type`. Every
 * line after line 1 that is one has a `seq`, counted in order from 1; a line that is not
 * (a torn write) has none, and is skipped by every reader alike.
 */
export function isStoredEvent(v: unknown): v is { ts: string; type: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.ts === "string" && typeof r.type === "string";
}

/**
 * Line 1 as a header. A file whose line 1 is not one (no id, creation time, model or owner)
 * is corrupt.
 */
export function parseHeader(line: string): ConversationHeader {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new CorruptConversationError("line 1 is not JSON");
  }
  if (!raw || typeof raw !== "object") throw new CorruptConversationError("line 1 is not a header");
  const str = (k: string) => (typeof raw[k] === "string" && raw[k] !== "" ? raw[k] : undefined);
  const id = str("id");
  const createdAt = str("createdAt");
  const model = str("model");
  const ownerId = str("ownerId");
  if (!id || !createdAt) throw new CorruptConversationError("the header has no id or createdAt");
  if (!model) throw new CorruptConversationError("the header has no model");
  if (!ownerId) throw new CorruptConversationError("the header has no ownerId");
  return {
    id,
    createdAt,
    updatedAt: str("updatedAt") ?? createdAt,
    model,
    ownerId,
    lastModel: typeof raw.lastModel === "string" ? raw.lastModel : null,
    ...(raw.metadata && typeof raw.metadata === "object"
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

function foldEvent(scan: Scan, parsed: Record<string, unknown>): void {
  const runId = typeof parsed.runId === "string" ? parsed.runId : null;
  if (parsed.type === "user.message") {
    scan.userMessages++;
    if (!scan.preview && Array.isArray(parsed.content)) {
      scan.preview = extractText(parsed.content);
    }
  } else if (parsed.type === "run.start" && runId) {
    scan.runStarts.push(runId);
  } else if (parsed.type === "llm.response" && runId) {
    scan.runsWithResponse.add(runId);
  } else if (parsed.type === "metadata.title" && typeof parsed.title === "string") {
    scan.title = parsed.title;
  }
}

/** Fold one line; false when it is not JSON. */
function foldLine(scan: Scan, line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isStoredEvent(parsed)) return true;
  // The event counts whatever its payload: a summary that cannot read it leaves it out,
  // and never fails the scan that `seq`, `append_events` and `delete` stand on.
  scan.events++;
  try {
    foldEvent(scan, parsed as Record<string, unknown>);
    if (parsed.ts && parsed.type) accumulateEventMetrics(parsed as ReadEvent, scan.metrics);
  } catch {
    // projection skipped for this event
  }
  return true;
}

/**
 * Fold the complete lines of `text`, and a final line without a newline only when it
 * parses: an append in flight is left for the next read. Returns the length consumed.
 */
function foldText(scan: Scan, text: string): number {
  const lastNl = text.lastIndexOf("\n");
  for (const line of text.slice(0, Math.max(lastNl, 0)).split("\n")) {
    if (line) foldLine(scan, line);
  }
  const tail = text.slice(lastNl + 1);
  if (tail && foldLine(scan, tail)) return text.length;
  return lastNl + 1;
}

const NEWLINE = 0x0a;

function cloneScan(scan: Scan): Scan {
  return {
    ...scan,
    header: { ...scan.header },
    runStarts: [...scan.runStarts],
    runsWithResponse: new Set(scan.runsWithResponse),
    metrics: { ...scan.metrics },
  };
}

async function resume(handle: FileHandle, prior: Scan, size: number): Promise<Scan | null> {
  const head = Buffer.alloc(prior.line1.length);
  const headRead = await handle.read(head, 0, head.length, 0);
  if (headRead.bytesRead !== head.length || !head.equals(prior.line1)) return null;
  const scan = cloneScan(prior);
  if (size > prior.offset) {
    const buf = Buffer.alloc(size - prior.offset);
    const { bytesRead } = await handle.read(buf, 0, buf.length, prior.offset);
    const text = buf.toString("utf8", 0, bytesRead);
    scan.offset += Buffer.byteLength(text.slice(0, foldText(scan, text)));
  }
  return scan;
}

/**
 * Scan a conversation file, resuming from `prior` when the file has only grown. Null when
 * the file is missing or empty; throws {@link CorruptConversationError} when line 1 is not
 * a header.
 */
export async function scanFile(path: string, prior?: Scan): Promise<Scan | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { ino, size } = await handle.stat();
    if (prior && prior.ino === ino && size >= prior.offset) {
      const resumed = await resume(handle, prior, size);
      if (resumed) return resumed;
    }
    const bytes = await handle.readFile();
    let leading = 0;
    while (leading < bytes.length && bytes[leading] === NEWLINE) leading++;
    const lineEnd = bytes.indexOf(NEWLINE, leading);
    const firstEnd = lineEnd < 0 ? bytes.length : lineEnd;
    if (firstEnd === leading) return null;
    const header = parseHeader(bytes.toString("utf8", leading, firstEnd));
    const scan: Scan = {
      header,
      line1: Buffer.from(bytes.subarray(0, firstEnd)),
      ino,
      offset: 0,
      preview: "",
      title: null,
      userMessages: 0,
      runStarts: [],
      runsWithResponse: new Set(),
      metrics: emptyMetrics(),
      events: 0,
    };
    const afterLine1 = Math.min(firstEnd + 1, bytes.length);
    const rest = bytes.toString("utf8", afterLine1);
    scan.offset = afterLine1 + Buffer.byteLength(rest.slice(0, foldText(scan, rest)));
    return scan;
  } finally {
    await handle.close();
  }
}
