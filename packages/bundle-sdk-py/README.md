# nimblebrain-bundle-sdk

Python SDK for NimbleBrain MCP bundles. Provides a typed wrapper around the
`ai.nimblebrain/host-resources` extension so bundle code can read workspace
files through the platform without going through the agent.

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
