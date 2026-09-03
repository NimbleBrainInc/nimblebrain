# 0025. Hook declarations come from operator-trusted catalog metadata; the runtime never parses a delivery body

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

A vendor with a "webhook URL" field delivers events over plain HTTPS. It cannot
carry a platform token, so it cannot enter through the fleet edge, and something
has to decide which workspace a delivery belongs to. The runtime is the only
component entitled to decide that: shared services *verify* a workspace claim,
they never *originate* one, and a server asserting its own workspace would invert
the isolation model.

So the runtime provides one generic door and originates identity on it. A server
declares its inbound streams; the runtime mints a capability URL for exactly one
`(tenant, workspace, connector, vendor)` and hands it to the tool the declaration
names; on delivery the runtime opens the capability, mints its ordinary
workspace-scoped platform token, and forwards the bytes unchanged to the declared
route.

Two things in that sentence are dangerous. The **route** chooses where this
runtime sends a request with a freshly minted platform token attached — so a
forged route is a request the platform makes, with the platform's credential, to
an address an attacker picked. And the **body** is arbitrary vendor content: the
moment runtime code reads a field out of it, the host has started knowing what
one vendor's events mean, and the split that makes a third-party stream work
identically to a first-party one has failed.

## Decision

**A hook declaration is read from the operator-published catalog entry, never
from caller-supplied input.** The declaration is authored by the server in its
host-extension metadata, but the copy the install path acts on is the one carried
through the catalog projection (`src/registries/projection.ts`), and at
provision time the trusted entry is found by the same slug rule the install used
(`getHookReconcileDeps`, `src/runtime/runtime.ts`) — derived from the installed
server's name rather than stored a second time, so the two cannot disagree after
a catalog edit.

**The declaration carries a name, a route, a tool, and prose — and nothing
about meaning** (`HookDeclaration`, `src/hooks/types.ts`). A vendor slug for
operator legibility, an absolute path on that same server, validated to stay
there; the name of a tool on that same server that accepts the minted URL, and
an optional description the runtime never acts on.

The registration tool is verified against the server's *advertised* tool list
before the URL is handed over — that it exists, and that its input schema
accepts the two string properties the runtime will send
(`verifyRegisterTool`, `src/hooks/provisioning.ts`). Checking the argument shape
as well as the name turns an undocumented half of the interface into a contract
that fails loudly, rather than one that fails at a first delivery months later
at a vendor nobody is watching. The provisioning runs as a reconcile
(`src/hooks/reconcile.ts`) on the two transitions that make both halves true —
a connection reaching running, and its tool set becoming enumerable — so the
invariant holds on a fresh install, on a boot, and on an interactive OAuth flow
that completes minutes after the install returned, without the same logic
appearing in three places.
There are no payload shapes and no event taxonomies, and that absence is what
makes the door generic — there is nothing here for the runtime to special-case
on.

**The runtime never parses a delivery body.** Signature verification, parsing,
idempotency, and state all belong to the server that declared the stream. The
one body-adjacent affordance is a header *rename* map, declared as
`{from: to}` — needed because the forward strips the header class a caller could
use to impersonate identity, and a vendor authenticating on a header in that
class would otherwise never reach its own verifier. It renames; it does not
interpret; values are never read.

**Not every host-metadata field needs this trust level, and the difference is
recorded.** The notifications outbox declaration sits beside `hooks` on the same
catalog projection today, but for a weaker reason: it grants no privilege — no
mint, no new audience, no path to a human — so a server's own `initialize`
result is a legitimate future source for it. `hooks` is not in that class.

## Consequences

- A third-party server declaring a stream gets byte-identical treatment to a
  first-party one, because there is nothing vendor-specific for the runtime to
  hold.
- Adding a vendor is a server change plus a catalog entry, never a runtime
  change. The kernel grows no per-vendor code.
- The blast radius of a compromised server is its own route with its own
  workspace-scoped token — the same reach it already had.
- The operator becomes a gate on adding an inbound stream. That is friction, and
  it is the friction that keeps a forged route from choosing where the platform
  sends a credentialed request.
- A malformed or hostile body reaches the declaring server intact and is that
  server's problem. The runtime cannot help, and cannot be tricked, because it
  never looked.

## Alternatives considered

- **Reading the declaration from the server's live `initialize` result** —
  rejected for `hooks` specifically: it puts the route under the control of
  whatever is answering at that URL, which is the thing the trusted copy exists
  to prevent. Left open for the notifications outbox, which grants nothing.
- **Reading the declaration from the caller-supplied install payload** — rejected
  for the same reason, more directly.
- **The runtime verifying vendor signatures** — rejected: it means per-vendor
  code and per-vendor secrets in the kernel, for a check the declaring server is
  better placed to make and already has the credential for.
- **A per-vendor door** — rejected: it is the same door N times, and the Nth one
  is where the identity-origination rule gets forgotten.
