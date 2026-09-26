# 0011. A server-published skill is a peer of a filesystem skill

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills, orchestrate remote MCP

## Context

An MCP server knows how its own tools are meant to be chained: which call comes
first, what to do with a partial result, which of two similar tools is the right
one. That knowledge is guidance, not code, and the MCP Skills Extension (SEP-2640,
`io.modelcontextprotocol/skills`) gives it a wire form: a server that declares
the extension lists its skills with `skills/list` — each entry a `SKILL.md` URI,
its frontmatter verbatim, and a manifest of the skill's files with digests — and
serves the files as resources. The body is an Agent Skills document like any
other.

The runtime already has a loader, a router, and four channels for exactly this
kind of document. The question is whether a skill that arrived over MCP is the
same kind of thing as one that came off disk, or a lesser kind that gets its own
narrower path.

Treating it as a lesser kind has a specific failure: the host decides the
server's loading behaviour on the server's behalf. Pin every server skill to one
channel and the server cannot say "this guide must be present before the first
call" — so the guide loads only after its tools are already in play, which is
after the model has already chosen wrong.

## Decision

**A server-published skill is a peer of a filesystem skill. Its frontmatter, not
its origin, decides its channel.**

**A server publishes skills only through the Skills extension.** The runtime
declares the extension, and against each MCP source in the active workspace
registry that declares it, enumerates `skills/list`
(`src/skills/connector-skills.ts`, driven from the runtime's per-source
discovery). The listing is the record of what is a skill on that server. A
server that does not declare the extension publishes none, and a `skill://`
resource is an ordinary resource whatever its path: the extension forbids
concluding that a resource is a skill from its URI scheme. The runtime never
constructs a URI from the source's name either: a server's name is its own, and
a guessed URI misses every server whose skill path and source name differ.

**A skill's body is fetched when it is needed, and verified.** Discovery reads
the listing alone; the entry's frontmatter carries everything routing needs. The
`SKILL.md` is read with `resources/read` when the skill reaches the model — an
`always` skill each turn it composes, a `dynamic` skill when selected or
activated — and is used only if its bytes match the listed digest and size and
its frontmatter matches the listed frontmatter. A verified body is cached by
digest, so an unchanged skill is not re-read and its composed bytes do not move.

**The declared loading configuration is read, not invented.** The same
`metadata.nimblebrain.*` fields the filesystem loader reads (ADR-0009) —
`loading-strategy`, `priority`, `triggers` — are read off the discovered skill's
frontmatter and stamped onto the synthesized manifest, so identical frontmatter
means identical behaviour whichever way the document arrived. The synthesized
skill then flows through `partitionSkillsByRole` like any other (ADR-0010): a
declared `always` reaches the context channel, and the default when a server
declares nothing is `dynamic`, tool-affined to that server's own namespace.

**Reading is lenient where authoring is strict.** A discovered skill comes from
an arbitrary server, so a malformed or absent `nimblebrain` block leaves the
fields undefined and the defaults apply — it never rejects the skill. Only
recognized values are taken: a strategy that is not `always` or `dynamic`, a
priority outside 0–100, a non-string or blank trigger are all dropped. A trigger
that is empty after trimming would substring-match every message.

**Identity is namespaced by the publisher.** The synthesized manifest name
carries the connector that published it, because the manifest name is the
de-duplication identity and two servers may both publish a skill called `usage`.
The prefix uses a character the on-disk name pattern forbids, so a name carrying
it can only have been built by the adapter.

**Trust does not follow the peer relationship.** A server-authored body is
third-party content. It is placed in the contained bucket of the prompt
regardless of the priority the server declares
(`partitionContextSkills`, `src/prompt/compose.ts`), so a server that declares
`always` with a low priority is contained, not promoted into the identity layer.
Peer means the same *channel* rules, not the same *trust* posture.

## Consequences

- A server ships guidance with its tools, in the same release, and the host
  honours it without a host change. The runtime never learns what any particular
  server's workflow means.
- A server can choose the reliable channel when it needs to, and pay for it. The
  choice — and the cost — sit with the party that knows the workflow.
- Discovery costs one `skills/list` per declaring source per discovery TTL, and
  nothing for a source that does not declare the extension. A body costs a
  `resources/read` the first time a given digest is needed.
- A server that serves `skill://` resources without declaring the extension
  publishes nothing here. Its author declares the extension and implements
  `skills/list` and `skills/get`.
- Two servers publishing the same skill name coexist, because the manifest name
  namespaces them. A server skill and a filesystem skill sharing a bare name do
  not — see ADR-0019.
- The blast radius of a hostile server is a contained block in the prompt, not an
  identity-layer injection. That is a containment defence, and containment is
  the defence — it is not a claim that server content is safe.

## Alternatives considered

- **Treating every listed `skill://…/SKILL.md` resource as a skill** — rejected:
  the Skills extension forbids inferring a skill from a URI scheme, and a
  resource listing carries no digest to verify the body against.
- **Reading every body at discovery** — rejected: the extension forbids fetching
  a skill's files ahead of need, and the listing already carries what routing
  reads.
- **Deriving the skill URI from the source name** — rejected: it is a guess that
  fails silently against any server whose resource path differs from its name.
- **Pinning every server skill to the tool-affined channel** — rejected: it takes
  a decision the server is better placed to make, and the failure mode is a
  workflow guide that arrives after the model has already gone wrong.
- **A separate server-guide injection path with its own semantics** — rejected as
  the general mechanism: a second set of rules for the same kind of document,
  which then has to be kept in agreement with the first. The focused-app guide
  remains its own thing because it has genuinely different semantics (per-app
  focus rather than role-based composition), not because its content is a
  different kind.
