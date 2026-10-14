// ---------------------------------------------------------------------------
// The `hostCapabilities` this host declares in its `ui/initialize` answer
//
// A declaration is a promise the bridge keeps: every capability here has a
// `case` in `bridge.ts` that serves it, and everything the bridge serves is
// declared here. `@nimblebrain/synapse` checks the declaration before it
// sends — `callTool` and `readServerResource` reject with `HostCapabilityError`
// without `serverTools`/`serverResources`, `sendMessage` and
// `updateModelContext` send nothing without `message`/`updateModelContext`, and
// the NimbleBrain extensions are gated on `experimental`. An undeclared method
// is therefore one no app can reach, whatever the bridge does with it.
//
// This lives in a module of its own so the SDK-parity suite can drive the real
// SDK against the real declaration rather than a hand-written copy that goes
// stale the next time the bridge grows a method.
// ---------------------------------------------------------------------------

import { NIMBLEBRAIN_EXTENSIONS, UPLOAD_FILES_APPS, UPLOAD_FILES_METHOD } from "./extensions";
import { serverCapabilities } from "./relayed-notifications";

/**
 * The tasks extension's identifier (`io.modelcontextprotocol/tasks`, SEP-2663,
 * MCP 2026-07-28). Official extensions use the `io.modelcontextprotocol`
 * vendor prefix; a third party uses a reversed domain it owns.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/**
 * The extension's capability: an empty object, which says the host serves the
 * extension. An app opts a `tools/call` in by naming the extension in the
 * request's `_meta` client capabilities, and polls `tasks/get` and cancels
 * with `tasks/cancel`. The extension has no settings to declare.
 */
const TASKS_CAPABILITY = {} as const;

/** The NimbleBrain extensions `appName` is offered: `upload-files` only to the apps in `UPLOAD_FILES_APPS`. */
export function extensionsFor(appName: string): string[] {
  return NIMBLEBRAIN_EXTENSIONS.filter(
    (method) => method !== UPLOAD_FILES_METHOD || UPLOAD_FILES_APPS.has(appName),
  );
}

/**
 * Build the `hostCapabilities` object for `appName`'s `ui/initialize` answer.
 *
 * Built per handshake rather than held as a constant: `serverCapabilities()`
 * reads which server notifications the host relays, and an app is told only
 * about the ones it will actually receive.
 */
export function buildHostCapabilities(appName: string): Record<string, unknown> {
  return {
    openLinks: {},
    downloadFile: {},
    // The server's tool calls and resource reads/listings are proxied;
    // `listChanged` is set for each notification the host relays to the
    // server's views, and only those (relayed-notifications.ts).
    ...serverCapabilities(),
    logging: {},
    // Each names the content blocks the host reads off the request. It takes
    // the first text block of a `ui/message`, and both the text and the
    // structured content of a `ui/update-model-context`; anything else on
    // either is dropped, so promising it would be a promise the bridge breaks.
    message: { text: {} },
    updateModelContext: { text: {}, structuredContent: {} },
    experimental: {
      [TASKS_EXTENSION_ID]: TASKS_CAPABILITY,
      ...Object.fromEntries(extensionsFor(appName).map((method) => [method, {}])),
    },
  };
}
