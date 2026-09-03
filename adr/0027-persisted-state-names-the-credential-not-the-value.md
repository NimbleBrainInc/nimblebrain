# 0027. Persisted state names *what* credential it needs, never *where* the value lives

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

A connection needs a secret: an OAuth client secret, a bearer token, an API key,
a short-lived minted service token. The persisted record that describes the
connection has to say something about it.

Two things it could say. It could carry the *value*, which puts a live secret in
a workspace record that is read on every boot, serialized into diagnostics,
copied when a workspace is exported, and visible to anything with read access to
the record. Or it could carry a *location* — an environment variable name, a file
path — which is the same problem one level of indirection out: the record now
encodes the deployment's storage layout, so the record and the deployment have to
move together, and a self-hosted install and a managed one need different
records for the same connection.

The third option is that the record names *what* it needs and knows nothing about
where the value is kept.

## Decision

**Persisted connection state carries a credential reference, not a credential,
and not a location.** The reference is `{ ref: "credential", key: "..." }`
(`OAuthClientConfig`, `src/bundles/types.ts`) — a key in the workspace's
credential namespace and nothing more. Nothing in the record says whether that
key resolves from a file, an envelope-encrypted blob, or a cloud secret manager.

**Every secret goes through one store.** `CredentialStore`
(`src/tools/credential-store.ts`) is the interface: `get`, `put`, `delete`, keyed
by `(workspaceId, key)`. The interface is the boundary between call sites and the
backend, and it promises an opaque secret store rather than a file store — so a
managed deployment swaps in an encrypted implementation, with a per-workspace key
in a KMS, without touching a single caller. The self-host implementation is
plaintext on disk at mode 0600 via atomic temp-and-rename, in a directory created
0700, and is honest about being secure-enough-for-trusted-local-disk rather than
SaaS-grade.

**Resolved values are wrapped, not bare.** `get` returns `Redacted<string>`, so a
secret that reaches a logger or a stack trace renders as a placeholder. Code that
needs the actual value calls `.reveal()` at the boundary where it is used — an
HTTP header, a token-endpoint exchange — which makes every point of exposure a
visible call rather than an accident of formatting.

**Keys are validated as keys.** A credential key becomes a path component, so it
is constrained to a dotted-namespace shape and rejects traversal.

**Non-interactive machine credentials name a provider, not a value.** The
transport auth union's `{ type: "provider", provider, config }` arm
(`src/bundles/types.ts`) names a registered credential provider and hands it an
opaque config. `TransportCredentialProvider` (`src/tools/credential-provider.ts`)
is the kernel's one generic seam for that: the kernel never learns what a
provider's config means — issuer, audience, fleet — it asks for a credential for
`(workspaceId, config)` and presents what comes back. That config originates in
operator-published catalog metadata, never tenant input.

## Consequences

- A workspace record can be read, logged, exported, and diffed without leaking a
  secret, because it contains none.
- The same record works on a laptop and in a managed deployment. Storage strategy
  is a deployment decision expressed once, at the store, not encoded per
  connection.
- Rotating a secret is a `put` under the same key. Nothing that references it
  changes, and nothing has to be found and updated.
- The store is the chokepoint every secret read passes through, which is what
  makes a per-read audit trail a property of one implementation rather than a
  discipline every call site has to keep. The self-host implementation does not
  emit one; the interface is where it lands.
- The self-host backend is plaintext on disk. Anyone with the disk has the
  secrets. That is stated rather than obscured, and it is the swap point rather
  than the design.
- `Redacted` costs a `.reveal()` at every genuine use. That friction is the
  feature: it marks exactly where a secret becomes plaintext.

## Alternatives considered

- **Inline secret values in the workspace record** — rejected: a live secret in
  every read, every log, every export, every backup.
- **An environment-variable name in the record** — rejected: the record encodes
  the deployment's layout, so the same connection needs different records in
  different deployments, and the indirection buys nothing the key already gives.
- **A per-subsystem secret store** — rejected: N implementations of the same
  security-critical thing, and the audit and encryption story has to be right in
  all of them.
- **Returning bare strings from the store** — rejected: the first accidental log
  line is unrecoverable, and nothing about a `string` says not to print it.
