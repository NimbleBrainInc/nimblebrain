/**
 * Serving a file's body at a door that answers with the whole body
 * (`resources/read` of `files://` at the MCP door and the app bridge, a
 * connector's host-resources read): `resolve` as `host` with the caller's own
 * workspace and owner, then the body streamed from its download URL, counted
 * against the record. Absent is not found at every door alike
 * (`contracts/files/CONTRACT.md` §10.4).
 */

import type { FilesHost, OwnerScope } from "./host.ts";
import { TransferError } from "./transfer.ts";
import type { FileRecord } from "./types.ts";

/** A body read whole, with the record `resolve` answered. */
export interface FileBody {
  file: FileRecord;
  bytes: Uint8Array;
}

/** A body larger than the door serves whole. */
export class FileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxSize: number,
  ) {
    super(`The file is ${size} bytes; this door serves at most ${maxSize}`);
    this.name = "FileTooLargeError";
  }
}

/** Read a stream to its end into one buffer of the known `length`. */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let at = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.byteLength > length) throw new TransferError("the body ran past its length");
    out.set(value, at);
    at += value.byteLength;
  }
  if (at !== length) throw new TransferError("the body ended short");
  return out;
}

/**
 * The body of `uri` for its owner in its workspace, or null when `resolve`
 * found nothing. Throws {@link FileTooLargeError} past `maxSize` (checked
 * against the record before a byte is fetched), and a {@link TransferError}
 * when the download fails.
 */
export async function readFileBody(
  host: FilesHost,
  scope: OwnerScope,
  uri: string,
  maxSize: number,
): Promise<FileBody | null> {
  const [answer] = await host.resolve(scope, [uri]);
  if (!answer?.found) return null;
  if (answer.file.size > maxSize) throw new FileTooLargeError(answer.file.size, maxSize);
  const got = await host.transfer.download(answer.download.url, { size: answer.file.size });
  return { file: answer.file, bytes: await readAll(got.body, got.length) };
}
