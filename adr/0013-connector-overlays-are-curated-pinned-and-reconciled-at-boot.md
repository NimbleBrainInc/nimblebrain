# 0013. Connector overlays: one curated repo, pinned, content-addressed, reconciled at boot

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills, orchestrate remote MCP

## Context

Most connectors are third-party. Their tool descriptions are written for a
generic caller, and the model's first attempt against an unfamiliar one is often
a plausible wrong call — the wrong tool of two similar ones, a required
disambiguation step skipped. A server we do not control cannot be asked to ship a
skill (ADR-0011), so the guidance has to come from somewhere else.

Writing it into the runtime is the wrong home twice over: it is per-connector
knowledge in a generic kernel, and shipping a correction means shipping a
platform image. Fetching it live per turn is worse — a network dependency on the
prompt path, with no answer for what content a given run actually used.

## Decision

**Curated connector guidance is an overlay: one public repo, one pinned version,
fetched by connector identity, verified, cached by content, materialized into the
workspace at install, and re-bound at boot.**

**One repo, keyed by identity.** The curated repo holds `<identity>/SKILL.md` —
`gmail/SKILL.md`, and so on. One home, one naming rule, and the guidance is
public because it describes a public API.

**Pinned, and the pin is deploy-time config.** `repo` and `version` resolve from
operator config with defaults compiled into the image
(`src/config/connector-skills.ts`). Rolling forward means bumping the pin, never
re-pointing a tag: the cache treats a pinned version as immutable, so a moved tag
serves the cached body indefinitely.

**Fetch is fail-closed, and integrity is recorded.**
`resolveOverlay` (`src/skills/connector-skill-resolver.ts`) records the body's
sha256 and, when a caller already pinned one, refuses a body that does not match
it. A 404 means no overlay is curated for this connector — a no-op, cached as a
miss so repeated installs do not re-hit the network. Any other non-2xx, any
network error, and any integrity mismatch throws; nothing partial or tampered is
ever materialized.

**Content-addressed cache, keyed on `(identity, repo, version)`,** so one
connector installed across many workspaces fetches once and a version bump
re-resolves rather than serving stale content.

**Materialized into the workspace, into a store of its own.**
`materializeConnectorSkill` (`src/skills/connector-skill-store.ts`) writes the
overlay to `connector-skills/<server>/<skill>.md`, a sibling of the authored
`skills/` tree and deliberately not inside it: the authored-skill loader must
never pick an overlay up, because an overlay is not system-prompt content. The
runtime fields are re-stamped at materialize regardless of what the overlay
declares — `dynamic`, active, tool-affined to *this* install's namespace, and
`provenance.origin = "connector"` with the `connector:<identity>@<version>`
source ref. The binding is recorded on the install (`skillsLock`) with the
identity, the version, and the sha.

**Overlays ride the conversation history, once.** They are candidates for the
engine's surface-once hook: matched by tool-affinity at call time and delivered
into the history a single time per conversation. They never enter the cached
system prefix, so guidance for a connector the turn never touches costs nothing.

**Boot is the reconcile point** (`src/bundles/connector-skill-reconcile.ts`).
The pin only changes with a new image, which means a restart, so boot is exactly
when it can have moved. The reconcile re-binds any connector whose lock is stale
or absent. It is version-gated (a connector already at the pin does no fetch and
no write), additive only (a fetch returning nothing leaves the connector exactly
as it was, retried next boot), and non-fatal per connector and per workspace.

## Consequences

- Improving a connector's guidance is a commit to the curated repo plus a pin
  bump, not a platform code change. The refresh reaches every already-installed
  connector on the deploy that bumps the pin, with no operator or agent action.
- The model never learns that overlays have versions. There is no tool to
  refresh one, because a desired-state-to-a-pin invariant belongs in a boot
  reconcile, not in something the model has to remember to call.
- An overlay is auditable after the fact: the lock names which repo version and
  which exact bytes a workspace is running.
- **A removed overlay does not propagate.** A best-effort fetch cannot
  distinguish "deleted at the new pin" from a transient failure, and the
  reconcile refuses to clear working guidance on an ambiguous signal. Deprecating
  guidance means serving an empty or tombstone overlay at the new tag, not
  deleting the file.
- A connector with no curated overlay has no lock, so it is re-checked every
  boot. That is a disk read against the cached miss sentinel, not a network call:
  the network is hit once per `(identity, version)`, ever.
- An empty overlay body is treated as no overlay, at materialize and again at
  read. An empty body has nothing to surface, and the surface-once dedup marker
  is only written when something is delivered — so materializing one would
  re-fire on every matching call, forever.
- Curation is a standing cost, and it scales with the connector catalogue rather
  than with the platform. That is the honest price of guidance for servers we do
  not control.

## Alternatives considered

- **Guidance compiled into the runtime** — rejected: per-connector knowledge in
  a generic kernel, and a correction costs a platform release.
- **Fetching per turn** — rejected: a network dependency on the prompt path, and
  no record of what a past run actually read.
- **Materializing into the authored `skills/` tree** — rejected: the authored
  loader would compose third-party guidance into the system prompt, which is
  both the wrong channel and the wrong trust posture.
- **A refresh tool the agent calls** — rejected: it makes the model responsible
  for an invariant the platform can hold, and it fails exactly when nobody thinks
  to call it.
