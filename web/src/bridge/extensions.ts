// ---------------------------------------------------------------------------
// The NimbleBrain host extensions
//
// Methods this host serves that the MCP Apps spec has no equivalent for. Each
// name is both the wire method and the identifier the host declares in
// `hostCapabilities.experimental` to offer it.
//
// The declaration is the gate. `@nimblebrain/synapse` sends an extension only
// where the host declared it, so a method served here but missing from
// `NIMBLEBRAIN_EXTENSIONS` is one no app can ever reach — the picker rejects,
// `action` sends nothing, and keys are not captured. Serving and declaring are
// the same edit because they read the same list.
//
// `experimental` is where they go because the ext-apps host-capability type has
// no field for extensions and a spec client parses the handshake result against
// that type, dropping anything else. The MCP tasks capability travels the same
// way, for the same reason.
//
// The `ai.nimblebrain/` prefix is a reversed domain we own, which is how the
// spec names a third party's extensions.
// ---------------------------------------------------------------------------

/** App → host notification: run a host action (open an app or a conversation). */
export const ACTION_METHOD = "ai.nimblebrain/action";
/** App → host request: the host's file picker, answered `{ files }`. */
export const REQUEST_FILE_METHOD = "ai.nimblebrain/request-file";
/** App → host notification: a keyboard shortcut pressed inside the frame. */
export const KEYDOWN_METHOD = "ai.nimblebrain/keydown";

/** Every extension this host serves, and therefore declares. */
export const NIMBLEBRAIN_EXTENSIONS = [ACTION_METHOD, REQUEST_FILE_METHOD, KEYDOWN_METHOD] as const;
