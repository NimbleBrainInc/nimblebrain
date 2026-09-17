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

import { NIMBLEBRAIN_EXTENSIONS } from "./extensions";
import { serverCapabilities } from "./relayed-notifications";

/**
 * The identifier MCP Tasks is registered under as an official MCP extension
 * (`modelcontextprotocol/ext-tasks`). Official extensions use the
 * `io.modelcontextprotocol` vendor prefix; a third party uses a reversed domain
 * it owns.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** What the bridge answers of the tasks utility: `tasks/get`, `tasks/result`,
 *  `tasks/cancel`, and `tools/call` augmented with a task. */
const TASKS_CAPABILITY = {
  cancel: {},
  requests: { tools: { call: {} } },
} as const;

/**
 * Build the `hostCapabilities` object for a `ui/initialize` answer.
 *
 * Built per handshake rather than held as a constant: `serverCapabilities()`
 * reads which server notifications the host relays, and an app is told only
 * about the ones it will actually receive.
 */
export function buildHostCapabilities(): Record<string, unknown> {
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
      ...Object.fromEntries(NIMBLEBRAIN_EXTENSIONS.map((method) => [method, {}])),
    },
  };
}
