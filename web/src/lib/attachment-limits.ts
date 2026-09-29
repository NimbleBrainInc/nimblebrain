import { humanBytes } from "../api/format-error";
import type { FileLimits } from "../types";

/**
 * Why a set of attachments cannot be sent, or null when it can. The server holds
 * the same limits (`maxFilesPerMessage`, `maxFileSize`, `maxTotalSize`); stating
 * the first one broken here lets the composer say so before anything uploads.
 */
export function attachmentLimitProblem(
  files: readonly { name: string; size: number }[],
  limits: FileLimits | undefined,
): string | null {
  if (!limits || files.length === 0) return null;
  if (files.length > limits.maxFilesPerMessage) {
    const extra = files.length - limits.maxFilesPerMessage;
    return `Up to ${limits.maxFilesPerMessage} files per message. Remove ${extra} to send.`;
  }
  const tooBig = files.find((f) => f.size > limits.maxFileSize);
  if (tooBig) {
    return `"${tooBig.name}" is ${humanBytes(tooBig.size)}; each file can be up to ${humanBytes(limits.maxFileSize)}.`;
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > limits.maxTotalSize) {
    return `Attachments total ${humanBytes(total)}; a message can carry up to ${humanBytes(limits.maxTotalSize)}.`;
  }
  return null;
}

/** The attach button's hint: the limits, stated before anyone picks a file. */
export function attachmentLimitHint(limits: FileLimits | undefined): string {
  if (!limits) return "Attach files";
  return `Attach files (up to ${limits.maxFilesPerMessage}, ${humanBytes(limits.maxFileSize)} each)`;
}
