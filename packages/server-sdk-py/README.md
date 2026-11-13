# nimblebrain-server-sdk

The Python SDK for building MCP servers that run on NimbleBrain, whether the server ships its
own interface (an MCP app) or only tools (a connector). It covers what a server shares with the
NimbleBrain host it runs in. The MCP protocol itself comes from the `mcp` package, through
FastMCP.

| Package | What it is for |
| --- | --- |
| `nimblebrain-server-sdk` (this package) | A server's NimbleBrain host features: annotations, change announcements, the `ai.nimblebrain` extensions, skills, listing rows, record ids, host resources |
| [`nimblebrain-synapse`](https://pypi.org/project/nimblebrain-synapse/) (PyPI) | Serving a server's interface: one `ui://` component declared once, rendered in any MCP Apps host |
| [`@nimblebrain/synapse`](https://github.com/NimbleBrainInc/synapse) (npm) | Writing that interface, the half that runs in the browser |
| `@nimblebrain/sdk` (npm) | A program that calls NimbleBrain's API |

A server with an interface uses this package and `nimblebrain-synapse` together.

```bash
uv add nimblebrain-server-sdk
# or
pip install nimblebrain-server-sdk
```

```python
from fastmcp import FastMCP
from nimblebrain_server_sdk import ADDS, READS, announce_resource_list_changed

mcp = FastMCP("notes")
```

What it covers:

- [Annotating a tool](#annotating-a-tool): `READS`, `ADDS`, `CHANGES`.
- [Announcing a change](#announcing-a-change) so a server's views re-read.
- [Platform extensions](#platform-extensions): facets, lifecycle handlers, and the view a record
  opens in.
- [Skills](#skills) through the MCP Skills extension.
- [Listing rows](#bounding-a-listing-row) bounded for an agent's context, and
  [record ids](#minting-a-record-id).
- [Host resources](#host-resources): reading workspace files through the host.
- [Testing](#testing) a server the way a host reads it.

## Annotating a tool

`READS`, `ADDS` and `CHANGES` are the MCP spec's tool hints for a read, a write that loses
nothing already there, and a write that overwrites, removes, or acts on what is there. Under
the spec's defaults an unannotated tool is a destructive write, so give every tool one.

```python
@mcp.tool(annotations=READS)
async def get_note(note_id: str) -> dict: ...
```

## Announcing a change

A view re-reads when the server tells its host that the resource list changed. A write tool
calls this once its write has committed:

```python
from fastmcp import Context

@mcp.tool(annotations=ADDS)
async def save_note(text: str, ctx: Context | None = None) -> dict:
    row = await store.save(text)          # commits
    await announce_resource_list_changed(ctx)
    return {"note": row}
```

- **Writes announce, reads never do.** A read that announced would have every open view
  refreshing itself forever, including a read that writes on the way in (an audit row).
- **After the commit, and best-effort.** A failed send is logged
  (`announce_resource_list_changed_failed`, with the `tool` you pass), not raised: the write
  is stored either way, and reporting it as failed would have the agent make it again. A view
  that misses one catches up on its next read.
- **In the call's own response,** so it reaches the host that holds the workspace on either
  protocol era, without the server keeping a map of sessions.
- **No request, no announcement.** With no `ctx` and no active MCP request, it does nothing.

## Platform extensions

An MCP extension (SEP-2133) is a capability offered under a reverse-DNS identifier and
discovered through `server/discover`. NimbleBrain's `ai.nimblebrain/*` extensions add no
methods: each marks a primitive the host already reads (a resource, a tool, a template).

- **Only a 2026-07-28 peer sees an extension.** A legacy `initialize` never carries
  `capabilities.extensions`.
- **Fixed at construction.** FastMCP refuses a registration once the server is serving, and a
  second registration of one identifier.

### Advertising one

```python
from nimblebrain_server_sdk import add_platform_extension

add_platform_extension(mcp, "acme/widgets", {"version": 1})
```

`PlatformExtension` serves no methods of its own. An extension with methods subclasses
FastMCP's `ServerExtension`.

### Facets

A facet is a count a host shows without being asked: tickets blocked, drafts awaiting review.
See the [facets extension](https://docs.nimblebrain.ai/extensions/facets/).

```python
from nimblebrain_server_sdk import FACETS_EXTENSION_ID, facet_count, facet_meta

add_platform_extension(mcp, FACETS_EXTENSION_ID)

@mcp.resource(
    "acme://facets/blocked",
    name="tickets-blocked",
    title="Tickets blocked",
    mime_type="application/json",
    meta=facet_meta("critical"),
)
async def tickets_blocked() -> str:
    return facet_count(await count_blocked())
```

- **The marker is the contract.** A host takes a facet from the `_meta` key, never the URI.
- **`title` is the label,** rendered after the number.
- **The level** (`critical`, `warning`, `info`) belongs to the facet, not to a reading.
- **The read takes no arguments** and counts at the source for the caller's identity.
- **`facet_count` refuses** anything but an integer of at least zero.

### Lifecycle handlers

`ai.nimblebrain/lifecycle` tells a server it has been made available to a scope (`ready`) and
that it is about to be removed (`removing`). See the
[lifecycle extension](https://docs.nimblebrain.ai/extensions/lifecycle/).

```python
from nimblebrain_server_sdk import CHANGES, add_lifecycle_extension

lifecycle = add_lifecycle_extension(mcp)

@lifecycle.handler("ready", annotations=CHANGES)
async def workspace_ready(reason: str | None = None) -> str: ...

@lifecycle.handler("removing", annotations=CHANGES)
async def workspace_removing() -> str: ...
```

- **Refused at import:** a handler that requires a property, or a second handler for one event.
- **Synchronous:** registered without task support, since the host calls it directly.
- **`reason` if you want it:** a `ready` handler that declares it receives `install` or `resume`.
- **Listed to every client,** so a handler must be safe for any caller with the scope's
  identity: `removing` records intent and never destroys.
- **Not correct by the events alone.** Most hosts never send them: set up lazily on first use
  too, and sweep for state whose `removing` never came.

### The view a record opens in

A server with several views names the one that shows a kind of record on that record's
resource template:

```python
from nimblebrain_server_sdk import record_view_meta

@mcp.resource("acme://boards/{board_id}", name="board", meta=record_view_meta("ui://acme/boards"))
async def board(board_id: str) -> str: ...
```

## Skills

A server publishes skills by declaring `io.modelcontextprotocol/skills`. The
extension answers `skills/list` and `skills/get` with each skill's entry (its
`SKILL.md` URI, its frontmatter verbatim, and a `sha256` digest and byte size
for every file) and serves every file through `resources/read` at
`skill://<skill-path>/<file-path>`. A host verifies each file it reads against
the digest, so the bytes served and the bytes listed come from one place: the
extension. Do not also register `skill://` resources by hand: FastMCP serves
the last resource registered at a URI, so a FastMCP server that registers one
over a skill file fails at startup.

A skill is a directory holding a `SKILL.md` (frontmatter with `name` and
`description`) and any reference files:

```
skills/tasks/
├── SKILL.md
└── references/transitions.md
```

**FastMCP:** register every skill the server publishes in one call.

```python
from pathlib import Path
from fastmcp import FastMCP
from nimblebrain_server_sdk import add_skills

mcp = FastMCP("Tasks")
add_skills(mcp, [Path(__file__).parent / "skills" / "tasks"])
```

**`mcp` SDK `MCPServer`:**

```python
from mcp.server.mcpserver import MCPServer
from nimblebrain_server_sdk import MCPServerSkillsExtension

server = MCPServer("Tasks", extensions=[MCPServerSkillsExtension([SKILLS / "tasks"])])
```

**Generated or packaged files.** When a skill's files are not a directory of
their own (a `SKILL.md` built at startup, or one packaged beside other code),
pass a `SkillDefinition` with the skill path and the files keyed by their path
in the skill:

```python
from nimblebrain_server_sdk import SkillDefinition, add_skills

outreach = SkillDefinition(
    "outreach",  # served at skill://outreach/SKILL.md
    {
        "SKILL.md": render_skill_md("outreach"),
        "references/tone.md": (REFS / "tone.md").read_text(),
    },
)
add_skills(mcp, [SKILLS / "tasks", outreach])
```

The skill path may carry a prefix (`"acme/billing/refunds"`); its last segment
must equal the frontmatter `name`. A directory's skill path defaults to the
directory's name (`SkillDefinition.from_directory(dir, path=...)` overrides it).
Dotfiles and `__pycache__` are skipped.

Everything the spec requires of a skill is checked at construction, so a bad
skill fails when the server starts rather than on a host's first read: a
missing `SKILL.md` or frontmatter, a `name` outside the Agent Skills rules, a
`name` that differs from the last path segment, a file path that escapes the
skill or that a URI would encode differently, two skills at one URI.
A skill beyond the SEP-2640 limits (512 files or 16 MiB) warns.

Notes on the wire:

- Frontmatter is parsed with YAML 1.2 semantics for booleans, numbers, and
  dates (`yes`, `1:30`, and `2026-01-01` stay strings, and `017` is 17),
  matching the parsers hosts compare with.
- Text files are served as text resources and anything that is not UTF-8 as a
  blob; either way the digest covers the raw file bytes.
- `skills/list` returns every skill in one page. On protocol 2026-07-28 both
  results carry `ttlMs: 0` and `cacheScope: "private"`.
- On a 2025-era (`initialize`) connection the `mcp` SDK does not send
  `capabilities.extensions`, so only 2026-07-28 clients see the declaration.
  `skills/list` and `skills/get` answer on either.

### Conformance

The upstream suite's SEP-2640 server scenarios run against
`tests/conformance_server.py`, which serves the fixture skill and a generated
one. The scenarios are on the suite's `main` branch:

```bash
uv run python tests/conformance_server.py --port 3001            # or --server mcpserver
git clone https://github.com/modelcontextprotocol/conformance && cd conformance && npm ci
for s in enumeration manifest directory; do
  npm start -- server --url http://127.0.0.1:3001/mcp --scenario sep-2640-skills-$s
done
```

Both adapters pass every check. On FastMCP the manifest scenario warns
(`sep-2640-meta-prefix`) because FastMCP stamps its own `fastmcp` `_meta` key
on every resource; the `directory` checks skip because `resources/directory/read`
is not implemented.

## Bounding a listing row

A page of a few hundred rows with one unbounded text field each (a document's body, a ticket's
description) is a page no agent context can hold. A row carries such a field as a preview or
not at all, plus the `uri` the whole record is read from:

```python
from nimblebrain_server_sdk import PREVIEW_CHARS, listing_row

rows = [listing_row(r, omit=("body",)) for r in records]                       # drop it
rows = [listing_row(r, preview={"description": PREVIEW_CHARS}) for r in records]  # preview it
```

- **`omit` drops a field; `preview` replaces it** with `<field>_preview`, at most the given
  number of characters (200 by default), ending in `…` when cut. `None` stays `None`.
- **Everything else is copied,** `uri` included; the record passed in is not modified.
- **A preview of anything but text raises** `TypeError`.

## Minting a record id

A record id is `<prefix>_<ulid>`: opaque, never recycled, and sortable by mint time.

```python
from nimblebrain_server_sdk import new_prefixed_id

def new_ticket_id() -> str:
    return new_prefixed_id("tk")
```

- **The body is a ULID:** 26 characters of Crockford base32, a 48-bit millisecond timestamp
  then 80 random bits.
- **Strictly increasing in one process,** from any thread: within a millisecond the random part
  is incremented, and a clock that steps back holds at the last millisecond.
- **Uniqueness is the primary key's job.** The random bits make a collision across replicas
  unlikely, not impossible.

## Host resources

A server running on NimbleBrain receives a `Context` argument
in every tool handler. The platform advertises the
`ai.nimblebrain/host-resources` capability during the MCP `initialize`
handshake; when present, the server can issue
`ai.nimblebrain/resources/read` and `ai.nimblebrain/resources/list`
requests back to the platform to read files from the workspace's
`FileStore` — the same store the agent's `files__read` tool sees.

This SDK wraps that protocol. You write `await host(ctx).read(uri)` and
get bytes; the SDK takes care of capability detection, method names,
and Pydantic result types.

**Host resources work on 2025-era (`initialize`) connections only.** A read is a request from
the server to the client, and the 2026-07-28 protocol has no channel for one. On a 2026-07-28
connection `available` and `list_available` are `False` and `read`/`list` raise
`HostCapabilityMissing`, whatever the client advertised, so a server takes its fallback path
instead of failing on the wire.

### Quick start

```python
from fastmcp import Context
from nimblebrain_server_sdk import host, HostCapabilityMissing

@mcp.tool
async def start_research(
    seed_uri: str | None = None,
    seed_data: str | None = None,
    ctx: Context = None,
):
    h = host(ctx)
    if seed_uri and h.available:
        # Host supports the extension — read the file directly.
        result = await h.read(seed_uri)
        content = result.contents[0].text
    elif seed_data:
        # No URI, but the agent passed inline content. Common path for
        # hosts that don't (yet) advertise the extension.
        content = seed_data
    elif seed_uri and not h.available:
        # URI passed, but the host can't resolve it. Return a structured
        # tool error so the agent knows to retry with `seed_data` instead
        # — the Level-C fallback pattern.
        raise ValueError(
            "This host doesn't support ai.nimblebrain/host-resources. "
            "Pass file contents inline via `seed_data` instead."
        )
    else:
        raise ValueError("Provide `seed_data` or `seed_uri`.")

    ...  # do research with `content`
```

### API

```python
from nimblebrain_server_sdk import host

h = host(ctx)

# Capability detection — true when the platform advertised
# `ai.nimblebrain/host-resources` with `read.enabled: true`.
h.available

# Per-scheme detection. v1 only supports `files`; future schemes
# (`entities`, etc.) get added to the platform's advertisement.
h.supports_scheme("files")

# Read a single resource. Returns the MCP-standard `ReadResourceResult`.
# Raises `HostCapabilityMissing` when the host doesn't advertise the
# extension. Raises `mcp.shared.exceptions.MCPError` (match on `.code`)
# for `-32004` (rate limited), `-32005`
# (response too large), `-32002` (resource not found), `-32602`
# (invalid params, e.g. unsupported scheme).
result = await h.read("files://fl_abc123")
text = result.contents[0].text

# List resources with an optional filter. Filter rides in `_meta.filter`
# per the platform's wire convention; this SDK does the unwrap. Supports
# `mime_type` and `tags` filters; rejects pagination cursors with
# `-32602` (pagination is reserved for a later version).
listing = await h.list(mime_type="text/csv")
for entry in listing.resources:
    print(entry.name, entry.uri)
```

### Error codes

The host-resources extension uses the JSON-RPC impl-defined server-error
range (`-32000` to `-32099`) for quota/policy responses, distinct from
`-32603 InternalError`:

| Code | Meaning |
| --- | --- |
| `-32002` | Resource not found (also returned for cross-workspace lookups — no info leak) |
| `-32004` | Rate limited (per-server token bucket; carries `retryAfterMs` in `error.data`) |
| `-32005` | Response too large (whole-response cap; `error.data` carries `size`, `maxSize`) |
| `-32602` | Invalid params (unsupported URI scheme, malformed `tags`, unsupported cursor) |

Servers should match on specific codes to back off intelligently
rather than treating all errors as server faults.

## Testing

`nimblebrain_server_sdk.testing` checks a server the way a host reads it, on either era
(`mode="auto"` negotiates 2026-07-28, `mode="legacy"` 2025-11-25):

- **`served_skills(mcp, mode)`** lists the skills, reads every file back against its digest,
  checks `skills/get`, and on 2026-07-28 that the extension is declared. It returns the entries
  by `SKILL.md` URI.
- **`served_facets(mcp, mode)`** finds the marked resources, checks each title, MIME type and
  level, reads each count, and on 2026-07-28 that the extension is declared. It returns
  `{name: {"title", "level", "count"}}`.
- **`assert_bounded_rows(rows, unbounded=(...))`** asserts each row has a `uri`, none of the
  named fields, and no text over `max_chars` (1,000) at any depth. Seed each unbounded field
  longer than that first, so one that leaks under another name fails too.

## Releases

Released independently of the NimbleBrain runtime by `server-sdk-py/v*` git tags. Each tag
runs a workflow that tests, builds and publishes to PyPI. Pull requests that touch this package
run its lint, type check and tests on Python 3.11 and 3.13.

## Status

`v0.x` is pre-stable; the API may shift before `v1.0`. The `ai.nimblebrain/*` identifiers and
`_meta` keys are a wire contract with the host and do not change within a major.
