# 0077. Everything installed from a catalog is a plugin, and its record says what it owns

- Status: Accepted
- Date: 2026-11-27
- Serves: manage skills; orchestrate remote MCP; secure RBAC
- Amends: [ADR-0068](./0068-a-plugin-is-the-unit-of-install-and-a-catalog-vouches-for-it.md) (the AI Catalog is the install listing; the installed record names the plugin; pins move to installed artifacts), [ADR-0076](./0076-the-kernel-runs-apps-through-declared-interfaces-and-knows-none-by-name.md) (a catalog's shape, with an optional pin and a path source; plugins as the managed unit)

## Context

ADR-0068 makes a plugin the unit of install, but an install still records a
connector. `manage_connectors` writes a `ConnectorRef` with a `skillsLock`, and
nothing records which plugin the connector came from or what else that plugin
produced. Everything that needs the plugin finds it again by opening archives:

- **Skills.** `resolveServerSkills` (`src/skills/connector-skill-resolver.ts`)
  loads every plugin archive the catalog's index lists to find the skills bound
  to one server, at install and again in the boot reconcile
  (`src/connectors/runtime/connector-skill-reconcile.ts`). That reconcile is
  additive, so guidance a catalog removes never leaves an install.
- **Conversation starters.** `resolveServerConversationStarters` opens every
  archive on each starters call, to match a workspace's connectors back to
  plugins by registry name.
- **The plugin list.** `src/tools/plugin-listing.ts` projects each connector as a
  one-server plugin, because no stored fact says otherwise.

The listing is too thin for what reads it. The NimbleBrain index carries a name,
an archive URL and a digest, so Browse reads a second file, `connectors.yaml`, a
list of `ServerDetail`s, and can show neither a skill-only plugin nor anything a
plugin says about itself without opening it.

The pins are compiled into the image. `src/config/plugin-catalog.ts` holds the
digests of the index and the connector list, so moving the catalog forward is a
release, and every installed connector is re-bound when the pin moves. There is
one catalog: `NB_CURATED_CATALOG_DIR` replaces it wholesale rather than adding
to it.

The AI Catalog specification lists typed artifacts of any kind (plugins, skills,
MCP servers) by `url` and `digest`, or inline as `data`, with an `extensions`
map per entry. ADR-0068 rejected it as an install source because its server
entries link to Server Cards, which carry no auth. That objection holds for a
Server Card; it does not hold for an entry that carries its own server record.

## Decision

**A plugin is the only thing the runtime installs from a catalog, and an
installed-plugin record states exactly what each install produced.** Nothing is
ever found by scanning artifacts.

### The installed-plugin record

Every install from a catalog writes one record per owner (ADR-0069):

- `name@catalog`, the address it was installed by;
- the digest of the artifact fetched;
- exactly what it produced: its connectors (by server key and registry name),
  its skills, and its conversation starters.

**Uninstall removes exactly what the record lists.** A connection to a server
that two installed plugins name stays until the last of them is removed.
**Update replaces the digest and what that plugin owns**, and nothing else.
Conversation starters, the plugin list and Browse's installed state read
records, never archives.

**A managed skill is read-only.** It is marked with its plugin, and update and
uninstall replace or remove it. A person who wants to change one makes their own
copy, which is theirs and which no plugin touches.

### What a catalog lists

**A catalog may list plugins, skills and connectors, in any mix.** A single
skill or a single connector is surfaced as installable, and on install the
runtime packages it as a one-item plugin with a generated manifest. So there is
one install path and one record shape. The person sees a skill or a connector;
the packaging is internal.

### What is not a plugin

- **A person's own authored skills and connectors added by URL** (ADR-0065) are
  theirs: editable, never managed by a plugin, never removed by an uninstall.
- **System plugins** (ADR-0076's contract plugins: conversations, tasks, files)
  share the format and the one reader (`src/plugins/manifest.ts`), but the
  operator binds them in `plugins`. They are not installed from a catalog, have
  no installed-plugin record, and a catalog can never provide one.

### A catalog is `{source, policy, sha256?}`

```json
"catalogs": [
  { "source": "https://catalog.example-vendor.com/ai-catalog.json",
    "policy": "required", "sha256": "…" },
  { "source": "https://catalog.nimblebrain.ai/ai-catalog.json", "policy": "available" },
  { "source": "/etc/nimblebrain/catalogs/local", "policy": "available" }
]
```

- `source` is a listing URL or a path the operator mounts.
- `policy` is `required`, reconciled into every workspace (ADR-0076), or
  `available`, offered to install.
- `sha256` pins the listing. **A `required` catalog must be pinned**, so what
  every workspace receives changes only when the operator changes the pin. An
  `available` catalog may be read live: the runtime keeps its last good copy and
  refreshes it on an interval.

The operator's configuration holds the catalogs. A tenant control plane that
edits the same list comes later.

### The listing is an AI Catalog, and it is display only

A listing is an AI Catalog document. **Browse reads listings, never artifacts.**
An entry carries what Browse needs to show and gate it: `identifier`,
`displayName`, `description`, `tags`, `type`, `url` (or inline `data`),
`digest` and `publisher`, and under `extensions["ai.nimblebrain"]`:

- `iconUrl` and `category`;
- `servers`: each server key to `{name, auth}`, its registry name and how it
  signs in (`dcr`, `static`, or `broker`), so Browse can say what an install will
  ask for;
- `nimblebrainOnly`, as today.

In `plugin.json` the extension's `servers` stays key to registry name; the
published extension schema gives the listing entry's form its own definition, so
v1 still only adds.

**A listing can mislabel but never grant.** Install reads the verified artifact,
and only the artifact decides what is installed.

### Install

1. Look up `name@catalog` in the cached listing.
2. Fetch `url` and verify `digest` (or take inline `data`, verified the same
   way).
3. Validate the manifest; refuse a `stdio` server (ADR-0068).
4. For each server, read its record, a `ServerDetail`: the plugin archive's
   `ai.nimblebrain/servers/<key>.json`, or the listing's inline record for a bare
   connector. Connect as a catalog install does today.
5. Materialize the skills as managed skills.
6. Store the conversation starters.
7. Write the installed-plugin record.

**Pinning moves to what is installed.** Each record holds its artifact's digest.
No artifact digest or listing digest is compiled into the image.

### Several catalogs side by side

Items are addressed `name@catalog`, so two catalogs may list the same name. A
server connects once per owner however many plugins name it; its record comes
from whichever plugin installed it first and is never swapped silently. To
prefer one catalog's item over another's, the operator leaves it out of the
other's policy. There is no precedence logic.

### Updates

An entry whose digest differs from the record's is an update. From an
`available` catalog an admin applies it ("update available"); from a `required`
catalog the reconcile applies it.

## Consequences

- One install path, one record shape and one uninstall rule cover plugins,
  single skills and single connectors. What an install owns is read, not
  derived.
- Boot, starters and the plugin list stop opening archives; an artifact is read
  once, at install or update.
- Guidance a catalog removes leaves an install on its next update, because the
  record lists what the plugin owns.
- A catalog moves forward without a release. A `required` catalog moves when its
  operator changes the pin; an `available` one moves when its publisher
  publishes.
- A live `available` listing is trusted for display only. A compromised listing
  can show a false name or icon; it cannot change what an install fetches past
  its own digest, and the record pins that.
- A managed skill can no longer be edited in place. A person who wants a
  variant keeps a copy, and the copy does not receive the plugin's updates.
- A catalog publisher must write the entry extension (`servers` with auth,
  `iconUrl`, `category`) and a server record per server in each archive.
- Records are new stored state per owner, and every reader of installed state
  moves onto them.

### Existing installs

No data migration. A boot reconcile maps each installed connector to its plugin
through the listings' `servers` maps, fetches that plugin's artifact, and writes
its record, keeping the existing connection and credential. A connector no
listing names stays a bare connector, the owner's own. The connector-skill
materializations and `skillsLock` give way to the plugin's managed skills as each
record is written.

### Retired

- the zip-scanning skill and starter resolver (`connector-skill-resolver.ts`)
  and the additive skill reconcile;
- the image-compiled index and connector-list pins (`src/config/plugin-catalog.ts`);
- `connectors.yaml` as a runtime input;
- `NB_CURATED_CATALOG_DIR` as a replacement: it becomes one path catalog that
  adds to the others.

### Build order

Each step lands on its own:

1. the listing: the AI Catalog reader, the entry extension in the published
   schema, `catalogs` with URL and path sources, pins and live refresh, and
   Browse reading listings;
2. the installed-plugin record, and install, uninstall and update through it,
   with one-item packaging for a bare skill or connector and managed skills;
3. the boot reconcile for existing installs, and starters and the plugin list
   read from records;
4. `required` catalogs reconciled into every workspace;
5. retiring the resolver, the compiled pins, `connectors.yaml` and the
   replacing directory.

### Open

- The entry `type` for a bare connector whose server record is inline `data`.
- A connector that more than one listing entry names, at the existing-install
  reconcile.

## Alternatives considered

- **Three kinds managed three ways** (plugins, skills and connectors each with
  its own install, record and uninstall). Three lifecycles to keep consistent,
  and a skill and its server could drift apart. A one-item plugin costs a
  generated manifest.
- **Claude Code's marketplace as the listing.** It lists plugins only, and
  carries no icon or auth, so Browse would still open archives or read a second
  file.
- **The MCP Registry as the listing.** It lists servers only; skills and
  plugins would need another index beside it.
- **Eager fetching** (fetching every listed artifact to build Browse). It is the
  scan this decision removes, paid per listing refresh instead of per install.
