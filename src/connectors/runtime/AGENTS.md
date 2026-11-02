# Connector runtime

Scope: a live connection's life, `src/connectors/runtime/`. The `on_ready` / `on_removing` contract is in `src/lifecycle/AGENTS.md`; what blocks more than one replica is in `src/api/AGENTS.md`.

## Connector teardown is a function, and it has two callers

`uninstallWorkspaceConnector` (`src/connectors/runtime/uninstall.ts`) is the
whole of removing one connector from a workspace: the `on_removing` call, the
OAuth revoke, `lifecycle.uninstall` (the only path to `cleanupBrokeredState`,
and so the only thing that revokes a brokered connection at the vendor), the
workspace-record strip, the hook revoke, the cursor reset, the tool-surface
watches, the ready-notification record, the tool permissions, the owned secrets.
Order is the contract — see the file header.

**Deleting a container runs the same teardown as removing each thing it holds.**
`Runtime.deleteWorkspace` walks `ws.connectors`, calls it for each, and only
then hands the id to `WorkspaceStore.delete` for the archive-rename. Teardown
runs BEFORE the rename: `on_removing` needs the connector reachable, and the
credential cleanup needs the credential directory at its live path.

- **The workspace's tasks are disarmed first**, before the connector
  teardown and long before the rename: `TaskQuiescer.dropWorkspace` (the
  scheduler, handed over by the tasks source — the runtime may not import
  it) drops them from the in-memory `definitions` map. Nothing else does:
  `scheduler.reload()` is called only from the tasks tool surface, so a
  deleted workspace's tasks stayed armed until the process restarted. A
  targeted drop, never `reload()` — that rescans every workspace and owner on
  disk to learn one thing the caller already knows.
- `WorkspaceStore` imports nothing from `src/connectors/` and holds no lifecycle
  handle. The cascade is the runtime's; the store does the rename.
- `manage_workspaces delete` calls `Runtime.deleteWorkspace`, never
  `workspaceStore.delete` — which is why `ManageWorkspacesContext` carries a
  runtime handle.
- Best-effort per connector. Outcomes are collected and returned, not thrown: a
  vendor nobody can reach must not strand a workspace half-deleted, and a failed
  revoke has to stay nameable after the record that named it is archived.
- `ConnectorTeardownDeps` is a structural interface `Runtime` satisfies, so
  `src/connectors/` keeps no edge to the composition root.
- Which secrets an uninstall may delete is the CALLER's question, passed in. The
  tool subtracts keys a surviving sibling still names; a workspace delete passes
  none, because every connector is going and those keys are operator-set
  workspace secrets, which survive the rename into the archive. The connector's
  own credentials do NOT survive it — `lifecycle.uninstall` clears its
  `mcp-oauth.<server>.*` keys and any brokered credential dir a step before the
  rename. That asymmetry is the design: revoking upstream is the point.

## Connection credential re-validation

**Connection credential re-validation (`ConnectionRevalidator`).** A runtime-owned timer (sibling of `HealthMonitor`, started in `serve`) that detects connectors whose upstream authorization lapsed *without* a transport 401 — a brokered provider's downstream vendor account expiring while the platform→provider key stays valid. It polls each **registered provider's** probe through the generic `ConnectionHealthProbe` seam (`src/connectors/runtime/connection-probe.ts`; impls live per vendor under `src/connectors/providers/<vendor>/connection-probe.ts` — Composio and Smithery today) and flips `running → reauth_required` after N consecutive `credential_lost` verdicts (anti-flap; any API error/timeout is `indeterminate` = no-op; a flap-storm trips a circuit breaker that keeps all state). Dormant unless at least one provider contributes a probe, so a deployment with no brokered provider runs no sweep. Each provider owns its own kill switch — `connectors.providers.composio.monitorEnabled` and `connectors.providers.smithery.monitorEnabled` in `nimblebrain.json` (default on when that provider is configured) — while the sweep *cadence* is provider-agnostic: `NB_CONNECTION_REVALIDATE_INTERVAL_SECONDS` (default 300). A probe reports only what the product can act on: Smithery's returns `indeterminate` for `auth_required`/`input_required` and logs the broker's setup URL, because a `ConnectionLiveness` verdict cannot carry a remedy link and flipping without one strands the user. Does NOT touch transports/restart/`dead` — that stays `HealthMonitor`'s job (liveness-of-process vs. liveness-of-credential, two disjoint loops).

**`reauth_required` is credential state, and the lifecycle owns it.** It survives a restart through the `auth_lost` flag (`src/tools/AGENTS.md`), which the lifecycle also sets for a brokered connection entering `reauth_required` and clears when it returns to `running` (`persistBrokeredCredentialLoss`), so the boot seed does not read the broker's local account as connected. Nothing but the user's Reconnect leaves it: `HealthMonitor` is handed `awaitingReconnect` and skips such a source without counting it down, `tryRecoverSource` declines to rebuild one, and a failed Reconnect while the flag is set records `reauth_required`, not `dead`. `nb_connector_reauth_required` is read from these records, not from the monitor, because after a restart the connection may have no registered source to monitor.

## A minted fleet connector's credential comes from the catalog, at every start

A minted fleet connector (`auth.provider: minted`) mints with the `providerAuth` its **catalog entry** declares, read at every start, never with the copy its install stored. `resolveRefTransport` (`startup.ts`) is the one place that derives it, and every path that builds a connection from an installed ref goes through it: `startConnectorSource` (boot, recovery, install), the lifecycle's Reconnect and identity flows, and the webhook forward. A source those paths build re-derives it at each restart too (`resolveTransportConfig` on the remote mode), so HealthMonitor and inline recovery never reuse a grant the catalog withdrew or changed.

- Why: a copy of `providerAuth` on the ref never sees a catalog edit. An install stores only `provider: minted` (`installedProviderAuth` in `connector-tools.ts`); refs from older installs still carry a copy, which nothing reads. Per-service audiences and per-tenant grants are catalog decisions, so an existing install has to follow the catalog, and one whose entry is gone must have nothing to mint with.
- No bound entry (removed, at another URL, or no longer `minted`), or a catalog that cannot be read: the connector stays installed and does not start (`FleetConnectorUnavailableError`). The stored copy is never a fallback; an unreadable catalog is an operator configuration error.
- `readCatalog` is required for a minted ref. A caller that omits it gets a throw, not a silent start from the stored copy. Thread it through any new start path.
- A schema-invalid catalog entry is dropped at read, so its service's existing installs stop starting too.
