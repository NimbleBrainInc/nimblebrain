# 0012. Vendored provenance is loader-stamped, never on disk

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills, secure RBAC

## Context

A skill's `provenance` records who authored it — a chat session, an operator, a
connector overlay, an import. Those are audit facts, written when the skill is
created and stored with it.

One value in that union is not an audit fact. `vendored` marks a skill as the
platform's own scaffolding — the identity and bootstrap content that ships in the
source tree. Two decisions read it: the prompt composer renders a vendored
context skill raw in the identity layer rather than inside third-party
containment (`partitionContextSkills`, `src/prompt/compose.ts`), and the
user-facing activity surfaces exclude vendored skills so the platform's own
scaffolding is not narrated back to the user every turn.

Both are trust decisions. If the marker can be written into a file, then anything
that can put a file in a skills directory — an authoring tool, an import, a
connector overlay, a workspace whose store is writable by its members — can
claim to be the platform.

## Decision

**`provenance.origin = "vendored"` is stamped in memory at load, on the
platform's own source-tree directories, and exists nowhere on disk.**

The on-disk schema's `origin` union is `chat | admin | connector | import`
(`src/skills/schemas/skill-manifest.ts`). `vendored` is absent from it, so a
file declaring it fails validation and the skill is dropped. The in-memory
`SkillProvenance` union includes it, because that is where the value lives.

`markVendored` (`src/skills/loader.ts`) applies it, and only the two loaders that
read the package's own `core/` and `builtin/` directories call it. It never
overwrites: a skill that already declares a provenance keeps it, so the stamp
cannot launder an authored file that happens to sit in one of those paths.

The writer refuses to serialize it (`src/skills/writer.ts`): a manifest carrying
the marker round-trips to disk without it. A vendored skill is immutable anyway,
but the guard is on the write path rather than on the assumption that nothing
will try.

The synthesized manifest for a server-published skill (ADR-0011) is built from
scratch and sets no provenance at all, so no wire path can produce one.

## Consequences

- The trust signal is unforgeable by construction rather than by convention.
  Producing it requires being the file the platform shipped, in the directory
  the platform ships it in.
- The on-disk and in-memory provenance types differ by one member. That is
  deliberate and is the whole mechanism; the schema comment says so, because the
  natural instinct on seeing the asymmetry is to "fix" it.
- A platform-shipped skill cannot be inspected on disk to learn that it is
  trusted — the answer is which directory it is in. That is the correct answer
  and the only one that cannot be copied.
- Skills that carry the marker are excluded from the user-facing activity
  surfaces, so those surfaces show tenant activity rather than the platform
  talking to itself.

## Alternatives considered

- **A `vendored: true` frontmatter field** — rejected: any writer of a skill file
  can then assert platform trust, which is the entire failure this prevents.
- **A signature over vendored skill files** — rejected: it buys nothing over
  "the file is the one we shipped, at the path we ship it at," and adds a key to
  hold and rotate for a property that path already establishes.
- **Deriving trust from `scope`** — rejected: `scope` is a mutability label for
  the authoring UI and is set on derived skills for unrelated reasons. Two
  meanings on one field means the security-relevant one eventually loses.
