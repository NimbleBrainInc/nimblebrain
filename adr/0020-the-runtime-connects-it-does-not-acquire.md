# 0020. The runtime orchestrates over remote MCP; it does not acquire or execute a server's code

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

There are two halves to using a tool provider. **Acquisition** is getting the
code: resolving a package, downloading it, unpacking it, resolving the
credentials it declares, and spawning it as a process. **Orchestration** is using
the capability: connecting, listing, calling, recovering, keeping the connection
healthy.

Only the second one is what an agent runtime is for. The first is a supply-chain
problem, and doing it at run time puts the review at the worst possible moment —
after the decision to run, inside the process that holds the tenant's
credentials, with the tenant's own data in memory. There is no way to review a
package thoroughly enough at that point, because the review has to be fast enough
not to be felt.

The same review, done at image build and publish, has none of those constraints:
it happens before the process exists, once per artifact rather than once per
install, and its failure mode is a build that does not ship rather than a tenant
runtime already executing.

## Decision

**The runtime connects to MCP servers over a network. It does not acquire,
verify, or execute a server's code.**

`BundleRef` (`src/bundles/types.ts`) is one shape: a URL, plus the transport,
OAuth, and overlay-lock fields that describe how to reach that URL and who it
speaks as. There is no by-name and no by-path variant, because there is nothing
to resolve a name or a path into.

**Discovery is a catalog, behind one source interface.** `ConnectorSource`
(`src/registries/types.ts`) does one thing: `fetch()` returns raw upstream
`ServerDetail` entries for its instance. Everything uniform — scope filtering,
safety scrubbing, projection, deduplication, error aggregation — lives once in
the `ConnectorDirectory` facade, so callers ask the directory and never
construct or aggregate sources by hand. `RegistryType` is an open string keyed
into a source-factory map rather than a closed enum, so a new source is one
factory entry and one file rather than an enum edit that ripples through every
`switch` that ever matched on it.

**An entry that only describes a package is not installable.** A `packages[]`-only
`ServerDetail` describes code to download, which this runtime does not do, so it
projects as not installable rather than as a broken install.

The upstream `ServerDetail` wire shape is unchanged, and remains the interchange
format — the catalog is a set of published server descriptions, not a private
format.

## Consequences

- Supply-chain review moves to build and publish, where it has time and where
  failing is cheap. The runtime's threat surface for a hostile server is what a
  hostile *network peer* can do, not what hostile *code in this process* can do.
- The tenant pod runs no untrusted code beside tenant credentials. That is
  the single largest reduction in blast radius available to this design.
- A server must be *reachable* — hosted somewhere, addressable over HTTPS. A
  purely local, stdio-only server has no place to run under this model. That is
  the cost, and it is real for the developer-laptop case.
- The host holds no copy of a server's data and no view of its filesystem, so
  anything the host reports about a server's contents is answered over MCP by
  the server itself. A count the host computed locally would be a guess.
- Discovery stays extensible without the runtime knowing the sources: adding the
  upstream registry is a source, not a new concept.

## Alternatives considered

- **Acquire, but sandbox the subprocess** — rejected: a sandbox strong enough to
  matter is a container boundary, at which point the thing is a remote server
  with extra steps and a worse operational story.
- **Acquire, but only from a signed allowlist** — rejected: the allowlist is the
  publish-time review, and once it exists, running the artifact in the tenant pod
  buys nothing over running it as a service.
- **Keep both paths** — rejected: the acquisition path is only worth its cost if
  something depends on it, and every dependent is better served by the remote
  one. Two paths means every security property has to hold twice.
