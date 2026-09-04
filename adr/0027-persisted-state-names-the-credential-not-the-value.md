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

**Config carries references; the store holds values.** A persisted record names
the key it needs and says nothing about where that value lives — not whether it
resolves from a file, an envelope-encrypted blob, or a cloud secret manager. The
reference shape is a leaf module (`src/tools/credential-ref.ts`) that the config
types and the store both import and that imports nothing itself, so the two
cannot disagree about what a reference is. Anywhere a reference is accepted a
literal is still valid: a reference is the option, not the requirement, because
a self-host operator with one key in a file they already trust should not have
to run a CLI to boot.

**Every secret goes through one store.** `CredentialStore`
(`src/tools/credential-store.ts`) is the boundary between call sites and the
backend, and it promises an opaque secret store rather than a file store — so a
managed deployment swaps in an encrypted implementation, with a per-scope key in
a KMS, without touching a single caller. A key is resolved within a **scope**
rather than against one hardcoded partition, so instance-wide, workspace, and
per-user secrets are the same mechanism at three scopes rather than three
stores. The self-host implementation is plaintext on disk under its scope's
root, written 0600 via atomic temp-and-rename into a directory created 0700, and
is honest about being secure-enough-for-trusted-local-disk rather than
SaaS-grade.

**Resolved values are wrapped, not bare.** A resolved secret comes back as a
`Redacted<string>`, so one that reaches a logger or a stack trace renders as a
placeholder. Code that needs the actual value reveals it at the boundary where
it is used — an HTTP header, a token-endpoint exchange — which makes every point
of exposure a visible call rather than an accident of formatting, and gives the
store one place that knows a secret was *presented* rather than merely read.

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
  lets the audit trail be a property of one implementation rather than a
  discipline every call site has to keep. **The audit fires on `reveal()`, not
  on the read that produced it** — so the log records secrets that were
  *presented*, not secrets that were looked up, and once per resolved secret
  however many times its value is presented. That distinction is what keeps a
  surface probing for a configured secret on every row it renders from burying
  the real uses, and it is only expressible because the wrapper is the thing
  that knows about presentation.
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
