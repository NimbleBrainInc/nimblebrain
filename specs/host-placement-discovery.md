# Host placement discovery — design spec

> **Status: PROPOSED (for review)** · Internal design doc (not published docs). How an MCP server declares where its `ui://` app appears in the NimbleBrain host shell, and how the runtime registers it — on the conventional `ServerDetail._meta` interface, unified with how mpak bundles already work.

## The problem

A `ui://` MCP‑App (e.g. `ui://people/main`) renders fine *once the host knows to place it*. The host learns "this server has an app, put it in the sidebar" from a **placement declaration**. Today:

- **mpak bundles** declare it in their descriptor's `_meta["ai.nimblebrain/host"]`; the runtime reads it at install (`extractUiMeta`). Works.
- **Fleet connectors** (remote MCP services like People) declare nothing the runtime reads — `installRemote` never looks at the connector's `ServerDetail._meta`. So a fleet app ships a correct `ui://` resource and a correct placement and **never appears.**

This spec closes that gap on the **conventional interface** mpak already uses, rather than inventing a new one.

## First principle: an MCP server is an MCP server, at `ServerDetail._meta`

Both mpak bundles and fleet connectors are the **same wire shape** — the upstream MCP‑registry `ServerDetail` (`src/connectors/server-detail.ts`). The only difference is **delivery**:

| | Delivery of the `ServerDetail` | Today |
|---|---|---|
| **mpak bundle** | mpak registry **discovery** → cached manifest | works (`extractUiMeta`) |
| **fleet connector** | hand‑curated static catalog (`platform.yaml` via `StaticSource`) | **gap** — `installRemote` ignores `ServerDetail._meta` |

So the placement belongs where MCP extensions are *meant* to live and where mpak already reads it: **`ServerDetail._meta["ai.nimblebrain/host"]`**. The runtime reads it from the `ServerDetail` at install, **identically regardless of how the `ServerDetail` was delivered.** Delivery is a separate concern (see *Long‑term*), not a reason to invent a second declaration site.

### Why not on the `ui://` resource (rejected)

An earlier draft put the placement on the `ui://` resource's `_meta` and discovered it by scanning `resources/list`. **Rejected:**

- **Invented convention.** The MCP‑Apps standard discovers UI only via a *tool's* `_meta.ui.resourceUri` (tool‑output widgets) — it has no standalone/sidebar concept and no resource‑scan discovery. Scanning resources for our key is a NimbleBrain invention with no standards basis.
- **Wrong altitude.** Placement is **server‑level** metadata ("this server integrates as a sidebar app"), not resource‑level. Its home is the server descriptor, not a resource.
- **Cost.** It requires an outbound `resources/list`/read on every connect; `ServerDetail._meta` is read once from a descriptor the runtime already holds.

The `ui://` resource and its standard render hints (`_meta.ui.*` — CSP, `prefersBorder`) stay exactly as the MCP‑Apps standard defines them. We extend the standard **only** with the placement, in the conventional `ServerDetail._meta` extension slot.

## The contract (what a server declares)

In its **`ServerDetail` / `server.json` `_meta`** (the same descriptor mpak publishes to the registry and the fleet catalog carries):

```yaml
_meta:
  ai.nimblebrain/host:
    host_version: "1.1"            # contract version (see Versioning)
    name: People                  # untrusted display string
    icon: users                   # untrusted display string
    placements:
      - slot: sidebar.apps        # host-shell slot (taxonomy below)
        resourceUri: ui://people/main   # MUST be this server's own ui://
        label: People
```

The server still **serves** the standard `ui://people/main` app resource (`text/html;profile=mcp-app`) — that's unchanged and standard. The placement just *declares where it goes*, in the descriptor.

### Slot taxonomy (`src/bundles/types.ts`)

| Slot | Meaning |
|---|---|
| `sidebar` (priority `<10`) | ungrouped core nav (Home, Conversations) |
| `sidebar.<group>` | named group — `sidebar.apps` → an "Apps" group |
| `main` | main content area |

A fleet app like People uses `sidebar.apps`.

## How the runtime registers it (one read, the mpak path extended)

The runtime already reads `_meta["ai.nimblebrain/host"]` from a descriptor for mpak bundles (`extractUiMeta` → `installNamed`). This spec **extends the same read to fleet connectors**:

| Install path | Descriptor source | Read |
|---|---|---|
| in‑process kernel sources (Home, Files, …) | — | `getPlacements()` in‑code *(unchanged)* |
| **mpak bundle** (`installNamed`) | cached manifest from mpak discovery | `extractUiMeta` *(unchanged — already works)* |
| **fleet connector** (`installRemote`) | the connector's `ServerDetail` (from the catalog today) | **`extractUiMeta` on `ServerDetail._meta` — NEW** |

The single new mechanic: `installRemote` extracts `_meta["ai.nimblebrain/host"]` from the connector's `ServerDetail` and feeds the already‑threaded `ui` param. **No resource scanning, no manifest‑read deletion, no convergence PR** — the mpak path is untouched; the fleet path gains the read mpak already has.

## Trust model (validate at registration, fail‑closed)

Server‑declared chrome is untrusted; each placement is validated **before** registering, dropped individually on failure (connector still works tools‑only):

1. **Own‑resource only.** `resourceUri` MUST be `ui://<thisServer>/*` — a server places only its own resources, never another's or a host surface.
2. **Well‑formed slot** per the taxonomy. Unknown slot → drop that placement.
3. **Bounded display strings.** `name`/`label`/`icon` length‑bounded, rendered as text, never HTML‑interpolated into chrome.
4. **Render gated on grant.** Declaration ≠ surfacing. The `PlacementRegistry` is workspace‑scoped; a fleet connector's placement renders only for a workspace that has been *granted* the connector (catalog + `platformConnectors` + consent). No new grant authority.
5. **Malformed `_meta` → ignore.** Parsing never throws.

## Versioning & tolerance (the lock)

This contract is copied by every fleet server and by third parties. Host tolerance for the unrecognized is **part of the contract and MUST NOT change**:

- **Unknown `host_version`** → parse known fields best‑effort, never hard‑fail.
- **Unknown / malformed `slot`** → drop *that* placement, keep the rest.
- **Unknown extra keys** → ignored, never an error.

These let the contract evolve without a flag day between old/new hosts and servers.

## Composition with the standard tool→widget path

Unchanged and orthogonal. A server may declare, on a **tool**, `_meta.ui.resourceUri` (the SEP‑1865 tool‑output widget) **and** a sidebar app via this placement. We add the placement dimension; we do not touch the standard tool link.

## Migration (bridge via static config now)

1. **Runtime** (`products/nimblebrain/code`): `installRemote` reads `_meta["ai.nimblebrain/host"]` from the connector's `ServerDetail` via the existing `extractUiMeta`/`hostMetaToUiMeta` shape; add the trust validation. (`installNamed`/mpak unchanged.)
2. **Catalog (static config)** (`deployments/nimblebrain/connectors/platform.yaml`): add `_meta["ai.nimblebrain/host"]` to the People `ServerDetail` entry, hand‑copied from People's repo descriptor. *(Transient — removed when fleet discovery lands.)*
3. **People** (`platform/mcp-servers/people`): already declares the placement in its repo manifest; ensure it serves the standard `ui://people/main` (it does).
4. **Docs:** fold the contract into `docs/apps/placements.mdx` (the server‑facing reference).

## Long‑term: fleet discovery (a platform feature, removes the hand‑copy)

The static‑config bridge's only wart is that the People `ServerDetail` is hand‑copied into `platform.yaml`. The root cause is that **the fleet has no discovery** — it's a static curated catalog, while mpak has a registry. The long‑term improvement is a **fleet discovery feature on the platform**: each fleet server serves/publishes its own `ServerDetail` (mpak‑style), discovered by the runtime, so its `_meta` is server‑authored and single‑source — no hand‑copy, no drift. At that point fleet and mpak register **identically**, both reading `ServerDetail._meta` from a discovered descriptor.

This is **platform‑architecture** territory (cross‑service discovery/registry topology), tracked as a separate long‑term platform feature — **not a blocker for this work.** The runtime contract in this spec (`read ServerDetail._meta`) is forward‑compatible: when discovery lands, only *delivery* changes (served instead of hand‑copied), not the runtime read. Static config now, discovery later, same interface throughout.

## Out of scope (deliberately separate)

- **MIME‑type standards pass.** Our `ui://` servers serve plain `text/html`; the standard is `text/html;profile=mcp-app`. Render‑layer concern — a separate PR across all `ui://` servers.
- **In‑process kernel placements.** Home/Conversations/Files/Usage keep their in‑code `getPlacements()` declarations.
- **Resource‑`_meta` scanning** — rejected (see above).

## Open items

- Define length bounds for `name`/`label`/`icon`.
- Confirm the People repo's authored descriptor (manifest vs a dedicated `server.json`) and that the catalog copy is generated from it where possible, to minimize the transient drift window before fleet discovery.
