# Connector lifecycle

Scope: `src/lifecycle/` and the tool-surface watch in `src/tools/connector-surface.ts`. The teardown sequence that calls `on_removing` is in `src/connectors/runtime/AGENTS.md`.

## Connector lifecycle — the two callable moments

`src/lifecycle/` (`declaration.ts` parses, `notify.ts` calls) tells a connector
it became reachable in a workspace (`on_ready`, with
`{ reason: "install" | "resume" }`) and that it is about to be removed
(`on_removing`, no arguments). Declared as `_meta["ai.nimblebrain/host"].lifecycle`,
`host_version: "1.4"`; each value names a tool on that same server. Developer
contract: [`docs/apps/lifecycle.mdx`](../../docs/src/content/docs/apps/lifecycle.mdx).

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
- **`on_removing` fires before `lifecycle.uninstall` and before the OAuth
  revoke**, is best-effort, and never *fails* the uninstall — which does wait
  for it, bounded by a **5s deadline in `notifyRemoving` and by nothing else**.
  `verifyLifecycleTools` refuses a task-augmented handler (`awaitToolTaskResult`
  has no deadline of its own), but that check runs on the READY path and only
  warns — it has never gated this call, and it says nothing about a merely slow
  inline handler. Do not read it as the bound and delete the deadline as
  redundant; the wait is held where the guarantee is made. It also may never
  arrive — the docs say so in those words, because
  a bundle that leaks a third-party resource without it is relying on a call
  nothing guarantees.

The contract check (`verifyLifecycleTools`) mirrors `verifyRegisterTool` with a
weaker predicate — the tool exists and takes no *required* argument — and
deliberately does **not** require `reason` in the schema. The runtime sends an
argument the schema need not mention, which rests on the server framework
accepting and ignoring unknown arguments (FastMCP/pydantic does). Like the hooks
check it is a warning on a **successful** install, and an empty tool list is
"not ready yet", not a violation.

`ConnectorPort` and the tool-surface watch both reconciles run on live in
`src/tools/connector-surface.ts`. Two purposes subscribe independently
(`"hooks"`, `"lifecycle"`); `stopWatchingToolSurface` drops both on uninstall and
`stopAllToolSurfaceWatches` on shutdown, beside `resetReadyNotifications`.
