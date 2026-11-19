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
acquire, verify, or execute their code (ADR-0020), so it reaches a server only
over Streamable HTTP, and a plugin's local `stdio` server is code it would have
to run. And on a deployed instance, connectors come only from what its operator
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
- **A server only NimbleBrain can reach is named in the extension alone.** A
  brokered connector's session URL comes from its provider at install
  (ADR-0026), so it has no URL to put in `mcp.json`. Its plugin names the
  `ServerDetail` in `ai.nimblebrain` and nothing in `mcp.json`, and installs
  only on NimbleBrain.
- **A skill-only plugin is a plugin with no `mcp.json`.** A skill is never a
  catalog entry on its own.
- **A plugin's identity is a reverse-DNS name** whose namespace is verified the
  way the MCP Registry verifies server names. A short name such as `linear` is
  an alias a catalog assigns, never an identity.

### A source is pinned content

A plugin is fetched from a git repository, and an install records the commit
it resolved to, never a branch or tag. A catalog is pinned
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

NimbleBrain runs its own catalog. Authors publish servers
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
commit, and the connectors and skills it produced. The CLI, the web UI and
the platform API edit the declared list through the runtime; none of them
installs anything itself. Whether a plugin belongs to a workspace or a person,
and what that grants, is ADR-0069's.

Installing a plugin:

1. resolves its alias in the policy's catalogs to an identity and a pinned
   source;
2. fetches the source at its pinned commit;
3. validates the manifest;
4. for each server, resolves the named `ServerDetail` and connects as a catalog
   install does, or, with none named, connects by URL as ADR-0065 does where
   that is allowed;
5. materializes its skills;
6. writes the lock.

Removing a plugin reverses each step.

### A connector's guidance is a skill in its plugin

A plugin's `skills/` are installed with it and removed with it: pinned,
content-addressed, materialized into their own store, and re-bound at boot, the
mechanics of ADR-0013. Their names follow the publisher-prefix rule of
ADR-0034, as `plugin:<plugin>:<skill>`, so two plugins never shadow each other.

**A skill binds to a server by naming it.** A skill's `metadata.nimblebrain`
may name one of its plugin's servers, by its key in the plugin. Install stamps
that skill as an overlay is stamped today: `dynamic`, tool-affined to that
connector's namespace in this install, so it reaches the model before the
connector's first tool call (ADR-0053). A skill that names no server loads by
the ordinary channels (ADR-0010).

**The curated overlay is a plugin.** Guidance for a connector NimbleBrain does
not author (a brokered Gmail toolkit, a vendor's remote server) ships as that
connector's plugin in the NimbleBrain catalog: the server, named by its
`ServerDetail`, plus a skill bound to it. This supersedes ADR-0013's overlay
repo and ADR-0016's derived identity. The binding is stated in the plugin, so
nothing derives a connector's identity from its name.

A server whose author writes its guidance publishes it over the MCP Skills
Extension (ADR-0011), and its plugin needs no skill for it.

### A server is shared, not duplicated

Two plugins that name the same server for the same owner produce one
connection, authorized once and counted by the plugins that hold it. Removing
one plugin leaves the connection while another still holds it. A server
installed for a workspace and for a person is two connections, each with its
owner's credential, so neither account reaches the other's runs (ADR-0006).

### Every server is remote

A plugin's servers are reached over Streamable HTTP, and nothing runs a
`stdio` server: not the runtime, not the CLI, not the platform. A plugin whose
`mcp.json` names a `stdio` server is not installable, as a `packages[]`-only
`ServerDetail` is not (ADR-0020). The refusal names the server and is shown
before install. An author who wants their server on NimbleBrain runs it as a
remote MCP server.

### What a plugin carries that the runtime does not use

Hooks, commands, agents, `bin/`, and other hosts' reverse-domain folders are
ignored, and an install reports what it ignored. A2A agents are not a plugin
part.

### Words

- **Catalog**: a curated set offered for install.
- **Plugin**: what a person installs.
- **Connector**: a connection to one server, inside a plugin.
- **Skill**: a `SKILL.md` unit of guidance.
- **App**: a view a plugin's server places (`ui://`, MCP Apps). Some plugins
  have apps; a plugin is what is installed, an app is what is opened.

The glossary's *Catalog* entry, the model-facing list of ADR-0015, is
renamed *skill index*. ADR-0015 is unchanged in substance.

## Consequences

- A local install and a deployed instance start from the same data: a catalog
  and a declared list. What an instance starts with stops being a file only its
  operator writes.
- ADR-0020's catalog directory stays the extension point. Reconcile writes the
  resolved `ServerDetail`s into it, so the connector catalog's validation,
  scrubbing and projection apply unchanged.
- One mechanism pairs a connector with its guidance, for our connectors and a
  third party's alike. The overlay repo's entries move into the catalog as
  plugins, and the identity derivation and its misreadings go away.
- Guidance arrives with the plugin, not with the server. A connector added by
  URL (ADR-0065), or by another publisher's plugin that names the same server,
  does not get the NimbleBrain catalog's skill for it. On a deployed instance
  every connector comes through a plugin, so this reaches only local
  development and a second plugin for the same server.
- A plugin for a brokered connector installs only on NimbleBrain.
- A plugin from any Agent Plugins host installs on NimbleBrain unless it names
  a `stdio` server. A plugin from our catalog installs on those hosts, with its
  `ai.nimblebrain` fields ignored there, unless it is for a brokered
  connector.
- The runtime reads two manifest formats while Claude Code's differs from
  Agent Plugins. Agent Plugins is a 1.0 spec from 2026-08, so field changes will
  reach the parser.
- A curated catalog is ongoing work: review, pinning, and checking the
  `mcp.json` and `ServerDetail` URLs against each other.
- Published plugins that ship only local `stdio` servers do not install, and
  many do. Reach into that part of the ecosystem depends on their authors
  offering remote servers; the refusal says so, so a person knows why.
- Reverse-DNS identity needs namespace verification for plugins, which no
  spec defines.

### Open

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
5. the generated `ai-catalog.json`.

## Alternatives considered

- **An AI Catalog as the install source.** It links to Server Cards, which
  carry no auth configuration and no local packages, and the spec is a draft.
  It is an output here.
- **Servers only, with no bundle.** A third-party author has no way to ship
  guidance with their servers, and only NimbleBrain's overlay repo can pair a
  connector with a skill.
- **A NimbleBrain bundle format.** The ecosystem has one, and a private format
  makes every plugin a port.
- **The catalog accepting publishes.** That is a registry's job, with namespace
  verification and moderation. Servers already have one, and plugins publish to
  their own sources.
- **Running `stdio` servers, in the runtime or beside it.** In the runtime it
  reverses ADR-0020. Beside it (the CLI on the host, hosted execution on the
  platform) it makes NimbleBrain responsible for third-party code, its
  isolation and its cost. A remote server puts that with its author.
- **A per-entry "included by default" flag in the catalog.** What an instance
  starts with is the operator's decision, not the curator's, and one flag
  cannot differ between instances.
- **A skill as a catalog entry of its own.** No catalog format has a skill
  entry an installer reads. A skill-only plugin carries one.
