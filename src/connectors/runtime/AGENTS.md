# Connector runtime

Scope: a live connection's life, `src/connectors/runtime/`. The `on_ready` / `on_removing` contract is in `src/lifecycle/AGENTS.md`; the `replicas > 1` prerequisites are in `src/api/AGENTS.md`.

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
runs BEFORE the rename: `on_removing` needs the bundle reachable, and the
credential cleanup needs the credential directory at its live path.

- **The workspace's automations are disarmed first**, before the connector
  teardown and long before the rename: `AutomationQuiescer.dropWorkspace` (the
  scheduler, handed over by the automations source — the runtime may not import
  it) drops them from the in-memory `definitions` map. Nothing else does:
  `scheduler.reload()` is called only from the automations tool surface, so a
  deleted workspace's automations stayed armed until the process restarted. A
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

**Connection credential re-validation (`ConnectionRevalidator`).** A runtime-owned timer (sibling of `HealthMonitor`, started in `serve`) that detects connectors whose upstream authorization lapsed *without* a transport 401 — a brokered provider's downstream vendor account expiring while the platform→provider key stays valid. It polls each **registered provider's** probe through the generic `ConnectionHealthProbe` seam (`src/connectors/runtime/connection-probe.ts`; impls live per vendor under `src/connectors/providers/<vendor>/connection-probe.ts` — Composio and Smithery today) and flips `running → reauth_required` after N consecutive `credential_lost` verdicts (anti-flap; any API error/timeout is `indeterminate` = no-op; a flap-storm trips a circuit breaker that keeps all state). Dormant unless at least one provider contributes a probe, so a deployment with no brokered provider runs no sweep. Each provider owns its own kill switch — `connectors.providers.composio.monitorEnabled` and `connectors.providers.smithery.monitorEnabled` in `nimblebrain.json` (default on when that provider is configured) — while the sweep *cadence* is provider-agnostic: `NB_CONNECTION_REVALIDATE_INTERVAL_SECONDS` (default 300; the legacy `COMPOSIO_MONITOR_INTERVAL_SECONDS` is still honored but deprecated, warns once at startup, slated for removal #727). A probe reports only what the product can act on: Smithery's returns `indeterminate` for `auth_required`/`input_required` and logs the broker's setup URL, because a `ConnectionLiveness` verdict cannot carry a remedy link and flipping without one strands the user. Does NOT touch transports/restart/`dead` — that stays `HealthMonitor`'s job (liveness-of-process vs. liveness-of-credential, two disjoint loops).
