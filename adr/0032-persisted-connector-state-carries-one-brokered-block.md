# 0032. Persisted connector state carries one brokered block

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

ADR-0026 put the brokered *verbs* behind one seam: create a session, initiate,
connect a key, probe, mount routes. The *nouns* need the same treatment, or
tenant state ends up shaped like each vendor's coordinates.

A block typed per vendor on persisted connector state (`ConnectorRef`,
`src/connectors/runtime/types.ts`) pulls the kernel into every vendor's shape.
The auth-kind taxonomy becomes a closed union with a literal per vendor, mirrored
by hand wherever a kind is named. Reaching a persisted block from a probe target,
and the uninstall, disconnect, boot-probe and identity-teardown paths, each grow
an arm per vendor. Adding a brokered provider then means editing files that are
not about that provider.

The seam already declares the field the coordinates can ride on:
`ManagedSession.providerRef` carries opaque provider-scoped coordinates.

## Decision

**A brokered install persists one block, `{ provider, connectorId, providerRef }`
(`BrokeredRef`).**

- `provider` is the registered `ManagedConnectorProvider` id that minted the
  install. It is also the connector's auth kind.
- `connectorId` is the catalog entry the install came from. A brokered install
  persists a per-install session URL, so this id is the only way back to the
  entry.
- `providerRef` is `ManagedSession.providerRef` verbatim. The kernel never reads a
  key out of it; only that provider's own probe and teardown do.

Every consumer reads the block through one accessor, `brokeredRef()`
(`src/connectors/runtime/brokered.ts`), and a provider's local state lives under
one directory rule, `credentials/<provider>/<connectorId>/`, built in one place.

`ConnectorAuthKind` is an open string: a runtime-native kind, or the id of a
registered provider, validated against the registry rather than a literal union
(`src/connectors/auth-kind.ts`), the way the registry type opened for sources
(ADR-0020). A path that differs by provider dispatches through the registry.

## Consequences

- A new brokered provider adds its folder and its registry entry. Nothing in the
  kernel names it.
- The kernel holds no static knowledge of what `providerRef` contains, so a
  malformed block fails when its provider reads it, not when state loads.
- A third shape of coordinates is the provider's business; the moment the kernel
  reads a key out of `providerRef`, the seam carries a schema again.

## Alternatives considered

- **One block, plus a per-provider schema validated at install** — rejected for
  now: it fails earlier, at the cost of a schema registry and a second thing
  every provider must supply.
- **Keep the typed blocks and route only the dispatch arms through the
  registry** — rejected: it leaves the closed auth-kind union and its
  hand-mirrored copies.
- **Leave it** — rejected: the cost is paid on every new provider, inside files
  that are not about it.
