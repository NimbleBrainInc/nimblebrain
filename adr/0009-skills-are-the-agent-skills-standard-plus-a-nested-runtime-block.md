# 0009. A skill is the Agent Skills standard plus one nested runtime block

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills

## Context

A skill is a portable artifact. The same `SKILL.md` a developer writes for a
coding agent should load here, and a skill authored here should stay readable
by anything else that speaks the Agent Skills format. That portability is only
real if the standard's fields keep their standard meaning — a host that
redefines `description`, or adds a sibling top-level key, has forked the format
and produced something that merely resembles it.

But the runtime needs configuration the standard does not define: which prompt
channel a skill takes, what priority it carries within that channel, whether it
is muted, what tool globs or trigger phrases select it, and who authored it. The
standard already provides the place for exactly this. `metadata` is a
host-extensible map, so a host's fields belong inside it, under a key that names
the host.

The second force is drift. The frontmatter is read on three paths — the
filesystem loader, the authoring tools that write a skill back to disk, and the
adapter that synthesizes a skill from an MCP server's `skill://` resource. A
hand-written interface, a lenient parser, and a separate tool schema will not
stay in agreement about what a valid skill is; they will disagree quietly, in
the direction of accepting something one path cannot round-trip.

## Decision

**A skill file is the Agent Skills standard, unmodified, with the runtime's own
configuration nested under `metadata.nimblebrain`.** Standard fields —
`name`, `description`, `license`, `compatibility`, `allowed-tools`,
`metadata.author`, `metadata.version` — keep their standard meaning and their
standard place. No runtime field sits at the top level.

Inside that block the keys are kebab-case, matching the standard's own
convention rather than the runtime's camelCase: the file is written by a human
and read by other tools, so it reads like the format it is in.
`loading-strategy` is the block's only required member — a skill that declares a
`nimblebrain` block at all must say how it loads.

**One TypeBox schema is the contract** (`src/skills/schemas/skill-manifest.ts`).
`SkillFrontmatterSchema` validates what is on disk, sealed
(`additionalProperties: false`) at the top level and inside the `nimblebrain`
block, so an unrecognized runtime key is a validation error rather than a
silently ignored one. `mapFrontmatterToManifest` is the single projection
from the on-disk shape (nested, kebab, standard) to the flat camelCase
`SkillManifest` the rest of the runtime consumes. Validation returns typed errors;
the loader logs them and drops that one skill, so a malformed file never takes
its directory down with it.

**The projection supplies the defaults**, in one place: a file with no
`nimblebrain` block at all — a pristine source skill, loaded directly — resolves
to `dynamic`, priority 50, active. Nothing needs a `nimblebrain` block to work.

## Consequences

- A source skill needs no rewriting to load here, and a skill written here stays
  a valid Agent Skills document for any other host. The extension is inert to a
  reader that does not know the key.
- Every consumer of a skill's configuration reads the same fields through the
  same projection, so a new runtime field is added once and cannot be honoured
  on one path and ignored on another.
- Strict validation means a typo in a runtime key is loud. That is the intent:
  the alternative is a skill that loads and then never fires, which is the most
  expensive failure this subsystem has.
- `additionalProperties: true` on the standard `metadata` map lets generic
  third-party metadata (tags, categories) pass through untouched. The runtime
  neither reads nor rejects it.
- The nesting costs one level of indentation in every authored file, and the
  kebab/camel split means the on-disk name and the runtime name for the same
  field differ. Both are paid so the file is standard-shaped rather than
  convenient-shaped.

## Alternatives considered

- **Top-level runtime keys** (`loading-strategy:` beside `description:`) —
  rejected: it collides with the standard's namespace, so any field the standard
  later adds is a breaking change, and a strict standard-conformance check on the
  file fails.
- **A sidecar config file per skill** — rejected: two files that must agree, with
  nothing enforcing that they do, and a skill stops being one portable document.
- **A hand-written parser per call site** — rejected: this is the drift the
  single schema exists to remove.
