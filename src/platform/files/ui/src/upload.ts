import { formatSize } from "./format";

/**
 * What an `ai.nimblebrain/request-file` refusal says. The host answers a pick
 * with a JSON-RPC error when it refused any file, and puts
 * `{ files, errors }` in `error.data`: `errors` names each refused file and why,
 * `files` holds the entries it stored anyway. The SDK rejects with that `data`
 * on the error, so it is read off the error here.
 */
export interface UploadRefusal {
  /** One line per refused file, naming it and the reason. */
  errors: string[];
  /** The ids of the picked files stored despite the refusal. */
  storedIds: string[];
}

/** The refusal an upload error carries, or `null` for any other failure. */
export function readUploadRefusal(err: unknown): UploadRefusal | null {
  const data = (err as { data?: { files?: unknown; errors?: unknown } } | null)?.data;
  const errors = data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  if (!errors.every((e) => typeof e === "string")) return null;
  const files: unknown[] = Array.isArray(data?.files) ? data.files : [];
  const storedIds = files
    .map((f) => (f as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
  return { errors, storedIds };
}

/**
 * The limits the host's picker holds an upload to, published in hostContext as
 * `uploads`. Absent when the host states none.
 */
export interface UploadLimits {
  maxFileSize: number;
  maxTotalSize: number;
}

/** The limits stated before anyone picks a file, or `null` when the host gave none. */
export function uploadLimitHint(limits: UploadLimits | undefined): string | null {
  if (!limits) return null;
  return `Up to ${formatSize(limits.maxFileSize)} each, ${formatSize(limits.maxTotalSize)} per upload`;
}
