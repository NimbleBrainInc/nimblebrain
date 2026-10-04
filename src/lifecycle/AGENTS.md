# Connector lifecycle

Scope: `src/lifecycle/` and the tool-surface watch in `src/tools/connector-surface.ts`. The teardown sequence that calls `on_removing` is in `src/connectors/runtime/AGENTS.md`.

## Connector lifecycle — the two callable moments

`src/lifecycle/` (`declaration.ts` parses, `notify.ts` calls) tells a connector
it became reachable in a workspace (`on_ready`, with
`{ reason: "install" | "resume" }`) and that it is about to be removed
(`on_removing`, no arguments). Declared in one of two places, never both
for one connection (`Runtime.lifecycleDeclarationFor`):

- **On the wire**, as the `ai.nimblebrain/lifecycle` MCP extension: a server
  that advertises it marks its handler tools in `_meta`. The wire shape is
  `src/services/lifecycle-extension.ts` (no I/O); `bindings.ts` holds each
  connection's binding in memory, snapshotted on `running` and on every
  tool-set change, and rediscovered (reconnecting first) inside the removal
  deadline when none is held. A marker from a server that did not advertise
  the extension is not a handler. Never identify a handler by its name.
- **In the catalog**, as `_meta["ai.nimblebrain/host"].lifecycle`, for a server
  that does not advertise the extension. Each value names a tool on that same
  server. Deprecated: the projection warns once per entry and the catalog lint
  reports a non-failing warning (`warnCatalogLifecycleDeprecated`). Do not add
  behavior to this path; a later release deletes it.

Developer contract:
[`docs/extensions/lifecycle.mdx`](../../docs/src/content/docs/extensions/lifecycle.mdx).

**Two moments, because the notification is a tool call on the bundle.** Before a
connector is reachable there is no server to call; after teardown there is
nothing left. So extension is DECLARATIVE outside that window (install-time
secret collection, the uninstall-time hook revoke — both runtime acts off the
connector's record) and CALLABLE inside it. A `pre_install` proposal is a
proposal to run bundle code outside a bundle. Do not add events without that
argument.

**No vendor vocabulary.** Same line `HostManifestMeta.hooks` holds: the kernel
says *you were installed*, and what that means is the bundle's business. A
`provisioning:` block describing what to provision is the taxonomy trap.

Three rules that are load-bearing rather than stylistic:

- **`on_ready` does NOT reuse `singleFlight`, and this is the thing most likely
  to be "tidied up" back into a bug.** That flight exists to stop two concurrent
  MINTS diverging; `on_ready` mints nothing, so joining it tells a
  freshly-installed connector `resume` — or, once the dedupe set has the
  observer's success, skips the install call and takes the install notice with
  it. The install-path call is ungated; only the connection-running observer is
  deduped, by a per-`(workspace, connector)` **set**, never a timer.
  `test/integration/connector-lifecycle-notify.test.ts` pins both halves.
- **A fresh install therefore delivers TWO `on_ready` calls, racily.** At least
  once is the contract, handlers must be idempotent, and suppressing one needs
  "an install is in progress" state the runtime does not hold.
- **A connector's outbox is positioned before its `on_ready` handler is
  called** (`LifecycleNotifyDeps.positionOutbox`, `src/notifications/position.ts`).
  A first outbox read with no cursor skips everything already in the outbox,
  and install-time work finishes inside the poller's first interval, so a
  position taken after the handler steps over what the handler reports. Keep
  the call ahead of `callReady`, never let its failure withhold the handler,
  and keep the cursor write set-if-absent.
- **`on_removing` fires before `lifecycle.uninstall` and before the OAuth
  revoke**, is best-effort, and never *fails* the uninstall — which does wait
  for it, bounded by a **5s deadline in `notifyRemoving` and by nothing else**.
  Every lifecycle call is a plain inline `tools/call` (the lifecycle port in
  `getLifecycleNotifyDeps` passes `inline`), so it never waits on a task, but a
  merely slow inline handler is bounded by nothing else, and with no binding
  held the deadline also covers rediscovering it. Do not read
  `verifyLifecycleTools` as the bound and delete the deadline as redundant;
  the wait is held where the guarantee is made. It also may never
  arrive — the docs say so in those words, because
  a bundle that leaks a third-party resource without it is relying on a call
  nothing guarantees.

**Declared handlers are host-only** (`src/permissions/host-only-tools.ts`):
absent from every listing and refused on every door, for every principal,
admins included, through the same `Runtime.connectorAdmission` /
`connectorAdminDenial` pair `admin_tools` uses. `connectorGatesFor` feeds that
one predicate whichever declaration won; there is no second withholding path.
The kernel's own calls reach the source through `connectorPortForSource` and
pass no door, so they need no exemption; never add one by caller name.
`test/integration/connector-lifecycle-host-only.test.ts` pins both.

The contract check (`verifyLifecycleTools`) mirrors `verifyRegisterTool` with a
weaker predicate — the tool exists and takes no *required* argument — and
deliberately does **not** require `reason` in the schema. On the catalog path
the runtime sends an argument the schema need not mention, which rests on the
server framework accepting and ignoring unknown arguments (FastMCP/pydantic
does). On the extension path it sends `reason` only to a handler that declares
it, and admits `taskSupport: "optional"`; the binding's own rejections
(duplicate marker, unknown event, required argument) are install warnings too.
Like the hooks check it is a warning on a **successful** install, and an empty
tool list is "not ready yet", not a violation.

`ConnectorPort` and the tool-surface watch both reconciles run on live in
`src/tools/connector-surface.ts`. Three purposes subscribe independently
(`"hooks"`, `"lifecycle"`, `"lifecycle-binding"`); `stopWatchingToolSurface`
drops them all on uninstall and `stopAllToolSurfaceWatches` on shutdown, beside
`resetReadyNotifications` and `resetLifecycleBindings`.
The `"lifecycle"` and `"lifecycle-binding"` watches fire on the same change in
no fixed order, so on the extension path `notifyReady` reads the handlers off
the listing it fetched, never the held binding. A `ready` handler that listing
rejects leaves the attempt unsettled, so the fix is called on the next change.
