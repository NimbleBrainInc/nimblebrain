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

**Purging a deleted workspace runs the same teardown as removing each thing it holds.**
Deleting a workspace only stops its connectors (`Runtime.unloadWorkspaceConnectors`: the
registry, lifecycle instances, placements and per-process records go, nothing stored
changes and no connector is told), so a restore starts them again as boot does. The
teardown is the purge's (`Runtime.purgeWorkspaceConnectors`, `src/workspace/AGENTS.md`).

- **The purge starts the connectors first**, as a restore would
  (`loadWorkspaceConnectors`), because `on_removing` needs the connector reachable and the
  revoke needs its lifecycle instance and ref. Then it walks the record's `connectors`,
  calls this function for each, and drops what is left in the process.
- `WorkspaceStore` imports nothing from `src/connectors/` and holds no lifecycle
  handle. The cascade is the runtime's; the store writes the tombstone and removes the
  directory.
- `manage_workspaces delete`, `restore` and `purge` call the runtime, never the store's
  `delete` — which is why `ManageWorkspacesContext` carries a runtime handle.
- Best-effort per connector. Outcomes are collected and returned, not thrown: a vendor
  nobody can reach must not strand a purge, and a failed revoke is logged and named in
  an admin's purge answer.
- `ConnectorTeardownDeps` is a structural interface `Runtime` satisfies, so
  `src/connectors/` keeps no edge to the composition root.
- Which secrets an uninstall may delete is the CALLER's question, passed in. The tool
  subtracts keys a surviving sibling still names; a purge passes none and deletes every
  workspace secret itself afterwards. The connector's own credentials go either way:
  `lifecycle.uninstall` clears its `mcp-oauth.<server>.*` keys and any brokered
  credential dir, because revoking upstream is the point.

## Connection credential re-validation

**Connection credential re-validation (`ConnectionRevalidator`).** A runtime-owned timer (sibling of `HealthMonitor`, started in `serve`) that detects connectors whose upstream authorization lapsed *without* a transport 401 — a brokered provider's downstream vendor account expiring while the platform→provider key stays valid. It polls each **registered provider's** probe through the generic `ConnectionHealthProbe` seam (`src/connectors/runtime/connection-probe.ts`; impls live per vendor under `src/connectors/providers/<vendor>/connection-probe.ts` — Composio and Smithery today) and flips `running → reauth_required` after N consecutive `credential_lost` verdicts (anti-flap; any API error/timeout is `indeterminate` = no-op; a flap-storm trips a circuit breaker that keeps all state). Dormant unless at least one provider contributes a probe, so a deployment with no brokered provider runs no sweep. Each provider owns its own kill switch — `connectors.providers.composio.monitorEnabled` and `connectors.providers.smithery.monitorEnabled` in `nimblebrain.json` (default on when that provider is configured) — while the sweep *cadence* is provider-agnostic: `NB_CONNECTION_REVALIDATE_INTERVAL_SECONDS` (default 300). A probe reports only what the product can act on: Smithery's returns `indeterminate` for `auth_required`/`input_required` and logs the broker's setup URL, because a `ConnectionLiveness` verdict cannot carry a remedy link and flipping without one strands the user. Does NOT touch transports/restart/`dead` — that stays `HealthMonitor`'s job (liveness-of-process vs. liveness-of-credential, two disjoint loops).

**`reauth_required` is credential state, and the lifecycle owns it.** It survives a restart through the `auth_lost` flag (`src/tools/AGENTS.md`), which the lifecycle also sets for a brokered connection entering `reauth_required` and clears when it returns to `running` (`persistBrokeredCredentialLoss`), so the boot seed does not read the broker's local account as connected. Nothing but the user's Reconnect leaves it: `HealthMonitor` is handed `awaitingReconnect` and skips such a source without counting it down, `tryRecoverSource` declines to rebuild one, and a failed Reconnect while the flag is set records `reauth_required`, not `dead`. `nb_connector_reauth_required` is read from these records, not from the monitor, because after a restart the connection may have no registered source to monitor.

## A minted fleet connector's credential comes from the catalog, at every start

A minted fleet connector (`auth.provider: minted`) mints with the `providerAuth` its **catalog entry** declares, read at every start, never with the copy its install stored. `resolveRefTransport` (`startup.ts`) is the one place that derives it, and every path that builds a connection from an installed ref goes through it: `startConnectorSource` (boot, recovery, install), the lifecycle's Reconnect and identity flows, and the webhook forward. A source those paths build re-derives it at each restart too (`resolveTransportConfig` on the remote mode), so HealthMonitor and inline recovery never reuse a grant the catalog withdrew or changed.

- Why: a copy of `providerAuth` on the ref never sees a catalog edit. An install stores only `provider: minted` (`installedProviderAuth` in `connector-tools.ts`); refs from older installs still carry a copy, which nothing reads. Per-service audiences and per-tenant grants are catalog decisions, so an existing install has to follow the catalog, and one whose entry is gone must have nothing to mint with.
- No bound entry (removed, at another URL, or no longer `minted`), or a catalog that cannot be read: the connector stays installed and does not start (`FleetConnectorUnavailableError`). The stored copy is never a fallback; an unreadable catalog is an operator configuration error.
- `readCatalog` is required by type on every function that builds a connection from an installed ref (`resolveRefTransport`, `startConnectorSource`, the boot and install paths), so a new start path cannot omit it. A caller that starts no minted connector passes `NO_CATALOG` (`catalog/binding.ts`), which a minted connector reads as an unreadable catalog. The one runtime guard left is the lifecycle's: its reader is wired after construction (`setCatalogReader`), so an unwired one rejects instead.
- A schema-invalid catalog entry is dropped at read, so its service's existing installs stop starting too.
