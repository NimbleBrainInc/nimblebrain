# 0035. The secrets backend is configuration, and a value that claims to be sealed either opens or refuses

- Status: Accepted
- Date: 2026-09-13
- Serves: secure RBAC

## Context

ADR-0027 made `CredentialStore` the one door every secret goes through, and
promised that an encrypted implementation could stand behind it without a caller
changing. Its file implementation holds each secret as bytes on a disk. The disk
outlives the process, and so do its snapshots, its backups, and any copy of the
work directory — so a secret on it is readable by whoever reaches any of those,
long after the process that wrote it is gone.

Encryption at the storage layer answers that only where the deployment has one.
The runtime is also self-hosted on disks nobody configured for it, with no key
management service to lean on, so an answer that lives in the platform beneath
the runtime is no answer there.

Deployments also want different answers. One trusted host wants the file as it
is; one whose volumes are snapshotted wants ciphertext; a later one may want a
managed vault. That is a per-deployment choice, and a build flag or the presence
of an environment variable is the wrong place to make it.

Sealing creates new failure modes, and each is sharper than the problem it
solves if handled carelessly. A key can be lost, and with it the secrets. A
sealed file can be read by a runtime that cannot open it. A value can be damaged
so that it no longer looks sealed. And once files hold ciphertext, the documented
way to seed an operator's key — write the file by hand — stops working.

## Decision

**The backend is named by configuration.** `secrets.backend` names a backend in a
registry the composition root fills, and `secrets.config` is handed to that
backend opaquely — the kernel learns nothing about what it means, the way it
learns nothing about a credential provider's config. An unregistered name fails
boot. It never falls back: a deployment that asked for one backend and silently
got plaintext files is the worst outcome available here.

**Configuration names where key material lives; it never contains any.** It is
commonly rendered from a file under version control, so a key written into it is
a key committed to a repository. A schema keyword on `secrets.config` refuses an
inline key, and a property whose name ends in `Env` must be the name of an
environment variable.

**The file backend seals when `secrets.config.seal` is present.** A sealed value
is one line of versioned, dot-separated ASCII: a magic that is also the format
version, a key id, a salt, an IV, and AES-256-GCM ciphertext with its tag. The
data key is derived per value with HKDF over the ring key, salted, with an `info`
that binds the owning scope and the key name — so a file copied to another scope
or renamed to another key fails to open. Every seal draws a fresh salt and a
fresh IV. The key id is a MAC over a constant, never a digest of the key. The
key ring is an environment variable of one to three keys: the first seals, every
one opens, and that overlap is the rotation seam.

**Whether a value is sealed is decided by its magic alone.** A value that begins
with the magic either opens or throws — whether or not this process has a key,
and whatever else is wrong with it. It is never handed back as a secret. The
format's full grammar decides only whether a sealed value is well-formed, and a
malformed one is refused, not demoted to plaintext.

**A sealed value is opened when it is revealed, not when it is read.** A read
without a reveal is a presence probe, and the runtime probes for secrets across
every installed connector at boot and on every connections page. A value that
cannot be opened fails at the connection that uses it, which is already isolated
per connector. The failure is audited on the stream the reads go to, naming the
scope, the key, the reason and the wanted key id, never the value.

**Stored secrets are reconciled to the configured backend at boot.**
`CredentialStore` carries one optional lifecycle hook, `reconcile`, which the
composition root awaits before any secret is read. The file backend walks every
scope and re-seals what is plaintext or sealed under a key that no longer seals,
through the same atomic write a `put` uses, keeping each file's modification
time. One secret it cannot open, or one directory it cannot list, is logged and
left as it is rather than failing boot.

**After a reconcile that saw everything, plaintext is refused.** Sealing buys
confidentiality; refusing plaintext once everything is sealed is what buys
integrity, since otherwise anyone who can write the directory without holding
the key can plant a credential of their choosing. A skipped file or an
unreadable directory holds the refusal off, because a sweep that did not see
everything has not earned it. The refusal is lazy, like every other one here, so
a planted file cannot fail a probe.

**Operators write through a `secrets` subcommand, never the agent.** It resolves
configuration and the work directory exactly as the server does, builds the same
store, and calls the same methods. The value comes from standard input or a
prompt with the echo off, never from the command line. Nothing prints a value.
It is not a tool and never becomes one: a credential surface the model can call
is one a prompt injection can call.

## Consequences

- A deployment chooses plaintext or sealed files in configuration, and a vault is
  a second registration rather than a change to any caller or to the file store.
- **The ring is the secrets.** Losing every key means re-entering every secret by
  hand. Keeping the outgoing key loaded until the next rotation is what makes a
  mistake during one recoverable.
- **Enabling sealing is a one-way door.** Removing the seal configuration makes
  sealed files unreadable, loudly, not readable again. A runtime older than this
  decision has no refusal and would read ciphertext as a credential, so sealing
  should not be enabled until the release carrying it is past the point a
  deployment would roll back to.
- Converting a secret in place does not erase what it was. The plaintext remains
  in the volume's freed blocks and in every snapshot taken before the sweep, so
  anything once stored as plaintext should be rotated at its issuer, not just
  re-sealed.
- Sealing protects bytes at rest. It does not protect against anyone who can read
  the running process's environment, where the key is; that boundary is access
  control, not encryption.
- A backend that fetches over a network pays a round trip on every resolution,
  and resolution happens per request. Registering one is cheap; making one
  acceptable needs a caching design this decision does not provide.
- A hand-written plaintext file on a sealed deployment is refused until the next
  boot reconciles it. The subcommand is the path that takes effect immediately.
- The runtime owns an authenticated-encryption codec and an in-process key
  derivation, which is a security-critical construction to maintain rather than
  a reuse of an existing one.
- A deleted workspace's secrets are a retention concern, not a sealing one. The
  reconcile does not walk archived workspaces, because sealing a secret that
  should be gone would make it look handled.

## Alternatives considered

- **Encryption only in the storage layer beneath the runtime** — rejected as the
  whole answer: it protects one kind of deployment and gives a self-hosted one
  nothing.
- **Falling back to the file backend for an unknown name** — rejected: a typo is
  indistinguishable from a silent downgrade to plaintext.
- **A key inline in configuration** — rejected: the key would be committed with
  the file that carries it.
- **Deciding "sealed" on the full grammar** — rejected: a sealed value damaged out
  of the grammar would be read as plaintext and handed out as a credential.
- **Opening a sealed value on read** — rejected: one unopenable value would throw
  at every presence probe, failing boot and hiding the surface that repairs it.
- **Re-sealing lazily, on read** — rejected: a secret nobody reads stays
  plaintext indefinitely.
- **Accepting plaintext for as long as it appears** — rejected: write access to
  the directory would be enough to inject a credential.
- **A key id that is a hash of the key** — rejected: it publishes a digest of key
  material in every sealed file and every error that names it.
- **Exposing the secrets command as an agent tool** — rejected: any prompt
  injection becomes credential exfiltration across every scope.
