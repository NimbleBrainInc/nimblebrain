# 0068. A plugin is the unit of install, a catalog vouches for it, and the runtime reconciles what is installed

- Status: Proposed
- Date: 2026-11-18
- Serves: manage skills; orchestrate remote MCP; secure RBAC

## Context

What an instance offers comes from two mechanisms that do not know about each
other:

- **Connectors** come from one directory of upstream `ServerDetail` files
  (ADR-0020). Whatever writes that directory decides what an instance can
  install. Nothing in the runtime or the CLI fetches it from anywhere, so a
  local install offers only the example directory built into the image, and a
  hosted instance offers what its operator writes.
- **Skills** come from the filesystem tiers, from a server's `skills/list`
  (ADR-0011), and from one curated overlay repo keyed by connector identity
  (ADR-0013).

A connector and the guidance for using it are one thing to the person who
installs them, but no artifact carries both, and the set an instance starts with
is not data anyone publishes.

The ecosystem has meanwhile settled on formats for each part:

- **Servers.** `server.json` is the MCP Registry's format, and the Registry API
  (`/v0.1/servers`) is what clients and subregistries read. A subregistry
  carries its own fields under its own `_meta` key, and curating or featuring is
  left to it. The API is in preview.
- **Remote server identity.** An MCP Server Card (SEP-2127) describes a remote
  server's identity, icons and transports. It does not describe tools or local
  packages.
- **Skills.** The Agent Skills format (`SKILL.md`) is read by every major
  agent host. Servers publish skills over the MCP Skills Extension (SEP-2640),
  which the runtime already reads.
- **Bundles.** Agent Plugins 1.0 defines a plugin as a directory with a root
  `plugin.json`, an `mcp.json` of servers, and `skills/`. Host-specific parts
  go under reverse-domain names. It deliberately leaves distribution, install,
  permissions and trust undefined. Claude Code has its own manifest at
  `.claude-plugin/plugin.json` with the same `skills/` layout.
- **Plugin indexes.** Hosts list plugins from a `marketplace.json` in a git
  repo. Its location differs by host, and no HTTP API for a plugin registry is
  specified anywhere.
- **Discovery across domains.** The AI Catalog (`ai-catalog.json`) and ARD,
  which builds on it, list a domain's MCP servers, A2A agents, skills and
  plugins by link. Both are drafts, and their well-known path is not settled.

Two constraints frame the choice. The runtime connects to servers; it does not
acquire, verify, or execute their code (ADR-0020). Many published plugins
declare local `stdio` servers, which only something that executes code can
run. And on a deployed instance, connectors come only from what its operator
controls; a URL a person types is accepted only on a local install (ADR-0065).

## Decision

**A plugin is what a person installs, a catalog is a curated set of plugins
that someone vouches for, and the runtime reconciles the plugins an instance
declares into installed connectors and skills.**

### Five layers, five owners

| Layer | Answers | Owner |
|---|---|---|
| Artifact | What is this thing? | Its author |
| Source | Where is it published, under whose namespace? | Its publisher |
| Catalog | Which artifacts are offered, with what configuration? | A curator |
| Policy | Which catalogs and plugins this instance may use, and which it starts with | The operator |
| Installed state | What this workspace has | The runtime |

Each layer reads the one above it and never writes it.

### The artifact is the ecosystem's

- **A plugin is an Agent Plugins directory.** The runtime also reads
  `.claude-plugin/plugin.json`. NimbleBrain's own fields live under the
  `ai.nimblebrain` extension and nowhere else, so the same directory installs
  unchanged on other hosts.
- **A plugin names its servers in `mcp.json`.** For each server it may also
  name a `ServerDetail` (by its registry name) in its `ai.nimblebrain`
  extension. When it does, auth, placements and every other runtime field come
  from that `ServerDetail`'s `_meta`. The catalog's build checks that the URL
  in `mcp.json` matches one of the `ServerDetail`'s `remotes`.
- **A skill-only plugin is a plugin with no `mcp.json`.** A skill is never a
  catalog entry on its own.
- **A plugin's identity is a reverse-DNS name** whose namespace is verified the
  way the MCP Registry verifies server names. A short name such as `linear` is
  an alias a catalog assigns, never an identity.

### A source is pinned content

A plugin is fetched from a git repository or from mpak, and an install records
the commit or digest it resolved to, never a branch or tag. A catalog is pinned
the same way.

### A catalog vouches, and takes no submissions

A catalog serves:

- `/v0.1/servers`, the MCP Registry API, as a subregistry. Upstream
  `ServerDetail`s are mirrored unchanged, and the catalog's fields go under one
  `_meta` key, `ai.nimblebrain/connector` (with placements under
  `ai.nimblebrain/host`). Servers absent upstream are published by the catalog
  itself.
- a `marketplace.json` that lists its plugins, their aliases and their pinned
  sources, in the git-repo convention other hosts read, so a host other than
  NimbleBrain can add the catalog as a marketplace.
- a generated `ai-catalog.json`, which links each plugin and each server's
  Server Card. It is an output for outside discovery and never an input to
  install.

NimbleBrain's own catalog is `catalog.nimblebrain.ai`. Authors publish servers
to the MCP Registry and plugins to their own sources; a catalog includes them by
review.

### Policy belongs to the operator

An instance's configuration names the catalogs it trusts, the plugins it allows
or denies, and the plugins it starts with. A local install's defaults ship with
the CLI's configuration, and the default catalog's URL is a value an operator
can replace. A deployed instance installs only from catalogs its operator lists,
which keeps the rule that connectors there come from what the operator controls.

### Installed state is declared and reconciled at boot

The plugins a workspace should have are a declared list. The runtime makes the
installed state match it at boot and whenever the list changes, and writes the
result to a lock that records each plugin's identity, catalog, version, source
digest, and the connectors and skills it produced. The CLI, the web UI and
the platform API edit the declared list through the runtime; none of them
installs anything itself.

Installing a plugin:

1. resolves its alias in the policy's catalogs to an identity and a pinned
   source;
2. fetches the source and verifies it against the pinned digest;
3. validates the manifest;
4. for each server, resolves the named `ServerDetail` and connects as a catalog
   install does, or, with none named, connects by URL as ADR-0065 does where
   that is allowed;
5. materializes its skills;
6. writes the lock.

Removing a plugin reverses each step.

### Skills ride with their plugin

A plugin's skills use the overlay mechanics of ADR-0013: pinned,
content-addressed, materialized into their own store, and re-bound at boot.
Their names follow the publisher-prefix rule of ADR-0034, as
`plugin:<plugin>:<skill>`, so two plugins never shadow each other, and they take
the overlay's place in ADR-0019's order. The curated overlay repo becomes the
skills of the NimbleBrain catalog's plugins.

### A server is shared, not duplicated

Two plugins that name the same server produce one connection, authorized once
and counted by the plugins that hold it. Removing one plugin leaves the
connection while another still holds it.

### Code runs outside the runtime

The runtime still does not execute server code. A `stdio` server runs under an
**executor** outside the runtime that exposes it by URL, and the runtime
connects to that URL. On a local install the executor is the CLI on the host,
after the person consents at install. On the managed platform it is hosted
execution. Where policy allows no executor, the install is refused, and the
refusal is shown before install, not after.

### What a plugin carries that the runtime does not use

Hooks, commands, agents, `bin/`, and other hosts' reverse-domain folders are
ignored, and an install reports what it ignored. A2A agents are not a plugin
part.

### Words

- **Catalog**: a curated set offered for install.
- **Plugin**: what a person installs.
- **Connector**: a connection to one server, inside a plugin.
- **Skill**: a `SKILL.md` unit of guidance.

The glossary's *Catalog* entry, the model-facing list of ADR-0015, is
renamed *skill index*. ADR-0015 is unchanged in substance.

## Consequences

- A local install and a deployed instance start from the same data: a catalog
  and a declared list. What an instance starts with stops being a file only its
  operator writes.
- ADR-0020's catalog directory stays the extension point. Reconcile writes the
  resolved `ServerDetail`s into it, so the connector catalog's validation,
  scrubbing and projection apply unchanged.
- ADR-0013 is amended: the overlay repo is replaced by plugin skills under the
  same mechanics.
- A plugin from any Agent Plugins host installs on NimbleBrain. A plugin from
  our catalog installs on those hosts, with its `ai.nimblebrain` fields ignored
  there.
- The runtime reads two manifest formats while Claude Code's differs from
  Agent Plugins. Agent Plugins is a 1.0 spec from 2026-08, so field changes will
  reach the parser.
- A curated catalog is ongoing work: review, pinning, and checking the
  `mcp.json` and `ServerDetail` URLs against each other.
- Without an executor, a plugin with only `stdio` servers installs nothing
  useful, and a large share of published plugins are like that. The executor is
  the build step that decides how much of the ecosystem an instance can use.
- Reverse-DNS identity needs namespace verification for plugins, which no
  spec defines.

### Open

- How hosted execution isolates a third party's `stdio` server, and who pays
  for it.
- Whether mpak hosts plugin archives (signed, immutable, scanned) beside git
  sources.
- The `ai-catalog.json` well-known path, while the AI Catalog and ARD drafts
  disagree.
- Whether one plugin can carry brokered toolkits that share one auth flow and
  one provider.

### Build order

Each step stands alone:

1. the catalog serving `/v0.1/servers` and `marketplace.json`, the runtime
   reconciling a declared list from it;
2. plugin install, removal and listing in the runtime, with the CLI and web UI
   as clients;
3. policy: catalogs and allow and deny lists per instance;
4. third-party sources, pinning and the lock;
5. the executor, local first;
6. the generated `ai-catalog.json`.

## Alternatives considered

- **An AI Catalog as the install source.** It links to Server Cards, which
  carry no auth configuration and no local packages, and the spec is a draft.
  It is an output here.
- **Servers only, with skills kept in a separate repo.** The guidance and the
  connector it describes stay apart, and nothing installs the two together.
- **A NimbleBrain bundle format.** The ecosystem has one, and a private format
  makes every plugin a port.
- **The catalog accepting publishes.** That is a registry's job, with namespace
  verification and moderation. Servers already have one, and plugins publish to
  their own sources.
- **The runtime executing `stdio` servers.** That reverses ADR-0020. An executor
  outside the runtime gives the same reach without code in the kernel.
- **A per-entry "included by default" flag in the catalog.** What an instance
  starts with is the operator's decision, not the curator's, and one flag
  cannot differ between instances.
- **A skill as a catalog entry of its own.** No catalog format has a skill
  entry an installer reads. A skill-only plugin carries one.
