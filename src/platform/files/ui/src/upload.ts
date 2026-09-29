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
  /** How many of the picked files were stored despite the refusal. */
  stored: number;
}

/** The refusal an upload error carries, or `null` for any other failure. */
export function readUploadRefusal(err: unknown): UploadRefusal | null {
  const data = (err as { data?: { files?: unknown; errors?: unknown } } | null)?.data;
  const errors = data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  if (!errors.every((e) => typeof e === "string")) return null;
  return { errors, stored: Array.isArray(data?.files) ? data.files.length : 0 };
}
