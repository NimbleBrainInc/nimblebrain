// ---------------------------------------------------------------------------
// The bounds the bridge holds an app's extension requests to.
//
// An app's SDK keeps its own copy of some of these (a client cannot import a
// host), so they are named here, apart from the handlers that enforce them, for
// `web/scripts/gen-host-constants.ts` to publish in `schemas/host-bridge/v1/constants.json`.
// The bounds a schema drops a message over (the location trail) stay in
// `schemas.ts`, and the generator reads them off the schema.
// ---------------------------------------------------------------------------

/** The levels an `ai.nimblebrain/notify` notice may carry. */
export const NOTICE_LEVELS: ReadonlySet<string> = new Set(["success", "info", "warning", "error"]);
export const MAX_NOTICE_TITLE = 120;
export const MAX_NOTICE_DESCRIPTION = 500;
/** At most this many notices per app in any window of `NOTICE_WINDOW_MS`. */
export const NOTICE_BURST = 5;
export const NOTICE_WINDOW_MS = 10_000;

/** The picker's per-file cap when the host supplies no upload limits. */
export const DEFAULT_PICKER_MAX_SIZE = 26_214_400; // 25 MB
