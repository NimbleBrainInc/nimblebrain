# nimblebrain-bundle-sdk

Python SDK for NimbleBrain MCP bundles. It does two things:

- wraps the `ai.nimblebrain/host-resources` extension so bundle code can read
  workspace files through the platform without going through the agent, and
- serves a bundle's skills through the MCP Skills extension
  (`io.modelcontextprotocol/skills`, [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension)),
  which is how the NimbleBrain runtime discovers them. See [Skills](#skills).

```bash
uv add nimblebrain-bundle-sdk
# or
pip install nimblebrain-bundle-sdk
```

## What it's for

A bundle running on the NimbleBrain platform receives a `Context` argument
in every tool handler. The platform advertises the
`ai.nimblebrain/host-resources` capability during the MCP `initialize`
handshake; when present, the bundle can issue
`ai.nimblebrain/resources/read` and `ai.nimblebrain/resources/list`
requests back to the platform to read files from the workspace's
`FileStore` — the same store the agent's `files__read` tool sees.

This SDK wraps that protocol. You write `await host(ctx).read(uri)` and
get bytes; the SDK takes care of capability detection, method names,
and Pydantic result types.

## Quick start

```python
from fastmcp import Context
from nimblebrain_bundle_sdk import host, HostCapabilityMissing

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

## API

```python
from nimblebrain_bundle_sdk import host

h = host(ctx)

# Capability detection — true when the platform advertised
# `ai.nimblebrain/host-resources` with `read.enabled: true`.
h.available

# Per-scheme detection. v1 only supports `files`; future schemes
# (`entities`, etc.) get added to the platform's advertisement.
h.supports_scheme("files")

# Read a single resource. Returns the MCP-standard `ReadResourceResult`.
# Raises `HostCapabilityMissing` when the host doesn't advertise the
# extension. Raises `McpError` for `-32004` (rate limited), `-32005`
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

## Error codes

The host-resources extension uses the JSON-RPC impl-defined server-error
range (`-32000` to `-32099`) for quota/policy responses, distinct from
`-32603 InternalError`:

| Code | Meaning |
| --- | --- |
| `-32002` | Resource not found (also returned for cross-workspace lookups — no info leak) |
| `-32004` | Rate limited (per-bundle token bucket; carries `retryAfterMs` in `error.data`) |
| `-32005` | Response too large (whole-response cap; `error.data` carries `size`, `maxSize`) |
| `-32602` | Invalid params (unsupported URI scheme, malformed `tags`, unsupported cursor) |

Bundle authors should match on specific codes to back off intelligently
rather than treating all errors as server faults.

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

**FastMCP:**

```python
from pathlib import Path
from fastmcp import FastMCP
from nimblebrain_bundle_sdk import SkillsExtension

mcp = FastMCP("Tasks")
mcp.add_extension(SkillsExtension([Path(__file__).parent / "skills" / "tasks"]))
```

**`mcp` SDK `MCPServer`:**

```python
from mcp.server.mcpserver import MCPServer
from nimblebrain_bundle_sdk import MCPServerSkillsExtension

server = MCPServer("Tasks", extensions=[MCPServerSkillsExtension([SKILLS / "tasks"])])
```

**Generated or packaged files.** When a skill's files are not a directory of
their own (a `SKILL.md` built at startup, or one packaged beside other code),
pass a `SkillDefinition` with the skill path and the files keyed by their path
in the skill:

```python
from nimblebrain_bundle_sdk import SkillDefinition, SkillsExtension

outreach = SkillDefinition(
    "outreach",  # served at skill://outreach/SKILL.md
    {
        "SKILL.md": render_skill_md("outreach"),
        "references/tone.md": (REFS / "tone.md").read_text(),
    },
)
mcp.add_extension(SkillsExtension([SKILLS / "tasks", outreach]))
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

## Releases

This SDK is released independently of the NimbleBrain platform via
`bundle-sdk-py/v*` git tags. Each tag triggers a GitHub Actions workflow
that builds and publishes to PyPI.

The SDK tracks the platform's `ai.nimblebrain/host-resources` capability
shape — when the platform ships a v2 (range reads, write, etc.), the
SDK ships a matching minor version.

## Status

`v0.x` is pre-stable; the API may shift before `v1.0`. The wire
protocol is namespaced under `ai.nimblebrain/` and intentionally
shaped to be a clean rename if the extension ever upstreams to the
MCP spec.
