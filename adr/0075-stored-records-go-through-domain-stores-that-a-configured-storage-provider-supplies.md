# 0075. Stored records go through domain stores, and a configured storage provider supplies them

- Status: Accepted (ADR-0076, proposed, would supersede it)
- Date: 2026-11-22
- Serves: secure RBAC

## Context

The runtime keeps everything it owns on a local filesystem: conversations, task
definitions and run records, workspaces and their membership, notifications,
skills, files, the usage ledger, connection and OAuth records. That is the right
default for `npx nimblebrain` and local development: nothing to install, data a
person can read, and a work directory that is the whole state.

It is the wrong only choice for a hosted or enterprise deployment, which expects
storage it already knows how to operate:

- **More than one replica.** Mutable records are files guarded by in-process
  locks, so a second process sharing them loses writes, and shared network
  storage makes appends worse, not better. `src/api/AGENTS.md` ("Running more
  than one replica") names a transactional store as the fix for that class of
  blocker.
- **Queries.** A listing, search or aggregate is answered by reading the files
  that hold the records. Where the read is whole files, its cost grows with
  stored history rather than with the answer.
- **Operations.** Point-in-time recovery, replication across failure domains,
  retention and audit are properties operators expect from a managed database and
  an object store, not from one volume attached to one node.
- **A customer's choice.** An enterprise that runs the runtime itself may require
  its own database or object store, under its own keys and policies.

ADR-0035 made the secrets backend a configured, registered choice. Records have
no such seam. Some domains sit behind an interface, others build paths and call
`node:fs` directly, and some interfaces leak the medium: a method that returns a
file path, a synchronous append backed by a synchronous file write, an optional
method callers must feature-detect, a change callback that carries a path, an
in-process index that follows a file by byte offset, a platform app that parses
another component's files. An interface that leaks the medium cannot be
implemented by another medium, so a second backend today means rewriting its
callers.

## Decision

### The boundary

**Every record the runtime owns is read and written through a domain store, and
nothing else touches the medium.** A domain store is an interface named for its
domain whose methods are that domain's operations: append an event to a
conversation, list a workspace's conversation summaries after a cursor, claim
due runs. It is not a generic key-value or file API, because a generic API makes
a database imitate files and gives up indexes and transactions, the reasons to
have a database. No domain code, platform app, route or tool builds a storage
path, imports `node:fs` for stored records, or reads another domain's records
except through that domain's store. A platform app reaches stores through the
context its host gives it, never the medium, including an app built to deploy on
its own. A `check:*` script in `verify:static` enforces the boundary, with an
allowlist limited to providers, configuration files and the work-directory
bootstrap.

**What is a record.** A record is anything the runtime writes and later reads
back: conversations, tasks and runs, workspaces, notifications, skills, files,
usage, identity and connection records. Skills are records: the runtime writes
them through its tools, and the filesystem provider keeps storing them as
markdown files a person can edit. Configuration a person writes for the runtime
to read (`nimblebrain.json`, `instance.json`) is not a record and stays a file.
In-memory state that does not outlive the process, such as the run bus and
caches, is not storage, though a cache depends on the change contract below.

### The contract every store states

**Every store method is asynchronous, and no method is optional.** What a store
must do is in the interface, and a provider that cannot do it is not a provider.

**No method reveals the medium.** No method returns or accepts a path, a file
handle, a byte offset, a SQL fragment or a bucket key. A reference to a stored
object is an opaque id.

**Order and time belong to the store.** Appends to one stream (a conversation's
events, a task's runs) are ordered by a sequence number the store assigns, never
by a caller's lock or clock. A listing takes and returns an opaque cursor that
stays valid while records are inserted. A record's timestamps are data its
caller supplies; ordering never depends on them.

**Each method states its consistency under concurrent callers in other
processes**: an atomic append, a compare-and-set update against a version, or
last-writer-wins, said explicitly. A guarantee that holds only because there is
one process is written as that.

**Work that must happen once is claimed with a lease.** A claim (a due scheduled
run, a run ticket, a delivery) carries an expiry and a fencing token. The holder
renews it while working, a claim whose holder died expires and can be taken
again, and a write carrying a stale token is refused. An idempotency key is a
store feature, recorded atomically with the work it names.

**A store emits changes.** Each store publishes what changed (the record's id,
its scope and the kind of change) to subscribers, and a cache built on a store
subscribes rather than reading the medium. The provider declares whether changes
reach other processes. The filesystem provider's do not.

**An atomic write covers one aggregate.** When records must change together
within one aggregate (a run's record and its ticket), the store exposes that as
one method and the provider makes it atomic its own way: a transaction in a
database, an ordered, crash-safe sequence on files. Work spanning aggregates (a
run settling its batch item and its task's schedule, a workspace delete
cascading to its conversations, tasks and files) is a sequence of idempotent
steps, each recorded before the next, so a crash resumes it rather than
half-applying it. No caller opens, holds or passes a transaction handle, because
a handle would carry the medium above the interface and let a caller hold locks
across a model call.

**Every store operation is traced and measured** under the store and operation
name, so a slow store is visible whichever provider serves it.

### Providers

**One storage provider, named by configuration, serves a deployment's records.**
`storage.provider` names a provider in a registry the composition root fills,
and `storage.config` is handed to it opaquely, as ADR-0035 does for secrets. A
provider registers an implementation for each domain store it serves, all
sharing one connection, one tenancy context and one unit of backup and restore.
Boot fails on an unregistered provider, and on a provider that lacks a store the
runtime needs; nothing falls back to another provider. Configuration names where
connection details and credentials live and never contains a secret. The
`filesystem` provider is the default and needs no configuration, so
`npx nimblebrain` and local development behave as they do today.

**Large immutable bodies go to a blob store, chosen separately.** File uploads,
run deliverables and other write-once bodies are held by a `BlobStore` with its
own `storage.blobs.provider` (`filesystem` by default, an object store when
configured). A record holds a blob's opaque id, never its bytes. The blob is
written before the record that names it, and a sweep removes blobs no record
names once they are older than a grace period. Removing a record never removes a
blob directly.

**A provider declares its capabilities, and enforces the one it lacks.** The
capability that matters first is whether more than one process may share the
data. A single-process provider does not trust configuration to say how many
processes exist: it holds an exclusive lock on its data for the life of the
process, and a second process fails at boot naming the provider.

**A provider enforces tenancy beneath the code.** Every store call carries its
scope (workspace, and owner where the record has one), and no store method
crosses it. A database provider enforces the same scope below the code with
row-level security keyed on workspace and owner, set for each transaction
(`SET LOCAL`) so a pooled connection never carries another call's scope. Every
store call is therefore a transaction. Isolation between deployments is the
provider configuration's job (a database or schema per deployment), never a
shared table distinguished by a column alone.

**A provider owns its schema and brings it current at boot.** A database
provider creates and upgrades its schema in a reconcile the composition root
awaits before any store is used, the way ADR-0035's `reconcile` runs before any
secret is read. The reconcile takes an advisory lock so replicas starting
together run it once, and a change is made expand-then-contract (add what the
new version needs, stop using what it dropped, remove it in a later release) so
the outgoing version keeps working during a rollout. Nothing above the interface
depends on a table or column name.

**Records move between providers through the stores.** Changing a deployment's
provider is an export from one provider's stores and an import into another's,
through the same interfaces the runtime uses, with the runtime stopped. The
export is a versioned format that carries records and the blobs they name. It is
the one supported way to move data between mediums, and the same path serves
backup to a portable form and restore.

**One conformance suite defines every store.** Each store has a shared contract
suite run against every registered provider in CI: its operations, its scope
enforcement, its ordering and cursors, its change events, its claims, and its
stated consistency. The cases that need several processes run against providers
that declare that capability. A provider is registered only once it passes. The
suite, not any one provider's behaviour, is what a store means.

## Consequences

- `npx nimblebrain` keeps zero-configuration filesystem storage. A hosted or
  enterprise deployment configures a database provider and an object store
  without changing any caller, and a customer's own backend is a new
  registration that passes the conformance suite.
- Each domain moves behind its store one at a time, and only the filesystem
  provider serves a domain until it has moved. A database provider is usable for
  a deployment once every store that deployment needs is behind an interface it
  implements.
- The work before any database code is interface work: making every store method
  asynchronous, removing medium leaks, moving direct filesystem reads behind
  stores, and writing the conformance suites. It pays off with the filesystem
  provider alone, because each store's contract becomes explicit and tested.
- An operation that was cheap only because it read whatever files it wanted,
  such as deriving a listing from whole records on each read, becomes a store
  operation every provider serves. The filesystem provider meets it with derived
  data it maintains on write (an index or summary), a database provider with a
  query.
- More than one replica needs a provider that declares it, and the other
  blockers in `src/api/AGENTS.md` (work claimed once, shared caches, flows and
  locks) fixed as well. This decision gives those fixes their storage
  primitives (leases, cross-process change events) but does not remove them.
- The runtime gains a dependency surface it did not have: connection management,
  schema migrations, backups and a database's failure modes. Keeping providers
  interchangeable costs a conformance suite maintained alongside every store.
- Secrets stay behind `CredentialStore` and its own configured backend
  (ADR-0035). They have a different threat model (sealing, key rings, refusal on
  open), so a storage provider does not supply them; a database deployment may
  register a secrets backend on the same database as a separate choice.

## Alternatives considered

- **A generic key-value or file-like storage API.** Rejected: a database behind
  it can only imitate files, so it gains neither queries nor transactions.
- **Each domain chooses its own provider.** Rejected for records: one provider
  keeps one connection, one tenancy context and one backup unit, and a mix
  multiplies what an operator must run and restore. Blobs are the one deliberate
  split, because they are a different service.
- **A transaction handle callers pass between stores.** Rejected: it carries the
  medium above the interface and lets a caller hold locks across a model call.
- **Move each domain to its own networked service.** Rejected: the runtime's own
  records would need another service on every turn, a network hop on every
  write, and `npx nimblebrain` could not run alone.
- **Shared network storage under the existing files.** Rejected: it does not make
  read-modify-write or appends safe across processes, and leaves queries as file
  scans.
- **Postgres as the only backend.** Rejected: it would make a database a
  prerequisite for running the runtime on a laptop.
