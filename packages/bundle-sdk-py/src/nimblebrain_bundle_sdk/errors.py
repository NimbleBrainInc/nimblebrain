"""SDK-specific exceptions.

Wire-level errors from the platform come through as
`mcp.shared.exceptions.McpError` — the SDK does not wrap those, so
bundle authors can match on the JSON-RPC error code via the standard
exception path. `HostCapabilityMissing` is the only error the SDK
itself raises, and it signals a local condition ("this host hasn't
advertised the extension") rather than a wire response.
"""


class HostCapabilityMissing(Exception):
    """Raised when bundle code calls a host-resources method but the
    host hasn't advertised the capability in `initialize`.

    Catch this to implement the Level-C fallback pattern: when the
    capability is absent, return a structured tool error that tells
    the agent to call the tool again with inline content instead.

    Example:
        ```python
        try:
            result = await host(ctx).read(seed_uri)
        except HostCapabilityMissing:
            raise ValueError(
                "This host doesn't support ai.nimblebrain/host-resources. "
                "Pass file contents inline via `seed_data` instead."
            )
        ```
    """

    def __init__(self, capability_key: str):
        super().__init__(
            f"Host has not advertised the {capability_key!r} capability. "
            "Check `host(ctx).available` before calling read/list, or pass "
            "content via tool arguments instead."
        )
        self.capability_key = capability_key
