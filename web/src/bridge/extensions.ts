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
/**
 * App → host notification: where the app is, as its whole trail from its root
 * to the current view, `{ trail: [{ id, label }, …] }`, sent on every in-app
 * navigation. Each `id` is the view's stable address: the resource URI of what
 * it shows when there is one, so the same value opens it from anywhere. Each
 * one replaces the last, so the app stays the only owner of its location and a
 * lost message corrects itself on the next. Declaring it also tells the app
 * that the host shows its title and breadcrumb, so the app drops its own.
 */
export const LOCATION_METHOD = "ai.nimblebrain/location";
/**
 * Host → app notification: go to the trail entry whose `id` is in the params,
 * sent when the user picks an entry above the current view in the top bar (a
 * breadcrumb, or back to the entry before the last). The `id` is the
 * app's own, passed back unread. Sent only to an app that sent a trail, so it
 * needs no declaration of its own.
 */
export const NAVIGATE_METHOD = "ai.nimblebrain/navigate";

/** Every extension this host serves, and therefore declares. */
export const NIMBLEBRAIN_EXTENSIONS = [
  ACTION_METHOD,
  REQUEST_FILE_METHOD,
  KEYDOWN_METHOD,
  LOCATION_METHOD,
] as const;
