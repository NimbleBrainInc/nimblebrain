/**
 * Read the files of a zip archive held in memory.
 *
 * A plugin's source is a zip (ADR-0068), and the runtime reads only the small
 * text files in it, so this reads the central directory and inflates stored or
 * deflated entries, nothing more: no zip64, no encryption, no multi-disk.
 * Anything else is refused rather than guessed at.
 *
 * Callers verify the archive's digest before reading it; the caps here bound
 * what a well-formed archive can expand to, not whether it is trusted.
 */

import { inflateRawSync } from "node:zlib";

/** Largest total of inflated bytes one archive may produce. */
export const ZIP_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const STORED = 0;
const DEFLATED = 8;

/** Every regular file in the archive, keyed by its path inside it. */
export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  let total = 0;

  for (let i = 0; i < count; i++) {
    const entry = readCentralEntry(data, view, offset);
    offset = entry.next;
    if (entry.name.endsWith("/")) continue; // a directory entry
    total += entry.size;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new Error("zip: archive expands past its size cap");
    files.set(entry.name, readEntryBody(data, view, entry));
  }
  return files;
}

interface CentralEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  local: number;
  /** Offset of the next central directory entry. */
  next: number;
}

function readCentralEntry(data: Uint8Array, view: DataView, offset: number): CentralEntry {
  if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
    throw new Error("zip: central directory entry is malformed");
  }
  const nameLength = view.getUint16(offset + 28, true);
  const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength));
  if (view.getUint16(offset + 8, true) & 0x1) throw new Error(`zip: ${name} is encrypted`);
  if (name.startsWith("/") || name.split("/").includes("..")) {
    throw new Error(`zip: ${name} is not a relative path`);
  }
  return {
    name,
    method: view.getUint16(offset + 10, true),
    compressed: view.getUint32(offset + 20, true),
    size: view.getUint32(offset + 24, true),
    local: view.getUint32(offset + 42, true),
    next:
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true),
  };
}

function readEntryBody(data: Uint8Array, view: DataView, entry: CentralEntry): Uint8Array {
  const { name, local, compressed, size } = entry;
  if (local + 30 > data.byteLength || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new Error(`zip: ${name} has no local header`);
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const raw = data.subarray(start, start + compressed);
  if (raw.byteLength !== compressed) throw new Error(`zip: ${name} is truncated`);

  let body: Uint8Array;
  if (entry.method === STORED) body = raw;
  else if (entry.method === DEFLATED) body = inflateRawSync(raw, { maxOutputLength: size });
  else throw new Error(`zip: ${name} uses compression method ${entry.method}`);
  if (body.byteLength !== size) throw new Error(`zip: ${name} is not the size it declares`);
  return body;
}

function findEndOfCentralDirectory(view: DataView): number {
  const floor = Math.max(0, view.byteLength - EOCD_MIN - 0xffff);
  for (let at = view.byteLength - EOCD_MIN; at >= floor; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error("zip: no end of central directory");
}
