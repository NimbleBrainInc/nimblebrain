/** The files contract the kernel consumes (`contracts/files/CONTRACT.md`), by its permanent name. */
export const FILES_CONTRACT = "ai.nimblebrain.files";

/**
 * Where a host that starts the implementation passes its per-file limit, in
 * bytes (CONTRACT.md §6), so the intake and `begin_upload` refuse at one size.
 */
export const MAX_FILE_BYTES_ENV = "NB_FILES_MAX_FILE_BYTES";

/** The environment the host adds to the files server it starts: its own per-file limit. */
export function filesServerEnv(maxFileSize: number): Record<string, string> {
  return { [MAX_FILE_BYTES_ENV]: String(Math.floor(maxFileSize)) };
}
