# 0022. Every source is one `McpSource` over one transport union

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

The runtime's tool surface comes from several places: remote servers a workspace
installed, brokered sessions a provider minted, and the platform's own
capabilities — conversations, files, automations, skills, usage, the workspace
management tools.

The platform's own capabilities are the interesting case. They are ordinary
TypeScript in the same process, so the obvious implementation is a direct
function call behind a thin interface, with MCP reserved for the things that are
actually remote. That produces two tool systems: two ways to describe a tool, two
places `_meta` and `annotations` are read, two dispatch paths, two error shapes,
two recovery stories — and every capability the MCP SDK implements has to be
reimplemented for the internal one, or quietly not exist there.

## Decision

**Every source is an `McpSource` (`src/tools/mcp-source.ts`), and the only thing
that varies is which arm of one transport union it was constructed with.** The
class owns connection, listing, dispatch, task augmentation, resource reads,
recovery, and `_meta` handling once, for all of them.

**The kernel's own capabilities are MCP servers to themselves.**
`defineInProcessApp` (`src/tools/in-process-app.ts`) builds a real MCP `Server`
and connects it to an `McpSource` over an in-memory linked-pair transport. The
source is a genuine MCP client of a genuine MCP server that happens to live in
this process. Every capability the SDK implements — resources, tools,
instructions, tasks, prompts — works for a platform source for free, and works
identically to how it works for a remote one.

The in-memory pair is built by a factory, invoked on every start and restart,
because the pair is single-use once closed and the server end claims its
transport permanently. That is what makes a platform source restartable on the
same code path as any other.

**The transport arm is also a trust boundary,** and it is the honest one: it
means the bytes never left the process. It is what host-owned `_meta` markers are
conditioned on (ADR-0014), and what makes it correct for a platform source to
have no host-resources context — the platform talking to itself has no business
asking the host for resources.

**A capability declared is a capability served.** An in-process source advertises
`resources.listChanged` when it serves resources, and does not advertise
`resources.subscribe`, because no `resources/subscribe` handler is registered and
a conforming client that took the capability at its word would get
method-not-found.

## Consequences

- One implementation of listing, dispatch, coercion, validation, error
  classification, and recovery. A fix to any of them is a fix everywhere.
- A platform capability and a third-party server are interchangeable to
  everything above the source: the registry, the router, the surfacing filter,
  the prompt composer. Moving a capability out of the kernel and onto a remote
  server is a deployment change, not a rewrite.
- Platform tools pay MCP's serialization cost on an in-memory transport for calls
  that could have been a function call. That is the price of one code path, and
  it is measured in microseconds against calls that are otherwise dominated by
  model latency.
- Authoring a platform tool stays a function plus a JSON schema — the in-process
  helper absorbs the SDK boilerplate — so uniformity does not cost ergonomics.
- The two metadata namespaces stay distinct end to end: `_meta` for free-form
  reverse-DNS host conventions, `annotations` for the spec's closed set of
  behavioural hints. Both travel; neither is the other.

## Alternatives considered

- **A `ToolSource` interface with an MCP implementation and a native one** —
  rejected: the interface becomes the intersection of what both can do, so every
  MCP capability the native side lacks either gets reimplemented there or
  silently does not exist for platform tools.
- **Platform tools as a remote server on localhost** — rejected: it buys the
  uniformity the in-memory pair already gives, and pays a socket, a port, a
  lifecycle, and a trust boundary that is now a network one.
- **Direct function dispatch for platform tools, MCP for the rest** — rejected:
  it is the two-systems outcome, and the second system is always the one missing
  the fix.
