"""Constants for the `ai.nimblebrain/host-resources` extension.

Mirrors `src/host-resources/methods.ts` and the JSON-RPC error codes in
`src/host-resources/resolver.ts` and `src/host-resources/rate-limit.ts`
in the platform repo. Pinning the values in code so bundle authors
matching on `McpError.error.code` don't carry magic numbers.
"""

HOST_RESOURCES_CAPABILITY_KEY = "ai.nimblebrain/host-resources"

HOST_RESOURCES_READ_METHOD = "ai.nimblebrain/resources/read"
HOST_RESOURCES_LIST_METHOD = "ai.nimblebrain/resources/list"

# MCP-spec convention for "resource not found" responses to
# `resources/read`. The platform deliberately surfaces the same code
# from `ai.nimblebrain/resources/read` so a future upstream migration
# is a method-name rename, not an error-code rewrite.
#
# Note: cross-workspace lookups collapse to this code too — the
# platform never confirms that an ID exists in a different workspace.
# So "not found" on the wire means either genuinely-not-found OR
# not-in-this-workspace; the bundle has no way to tell, by design.
RESOURCE_NOT_FOUND = -32002

# JSON-RPC "Invalid params." Unsupported URI scheme, malformed tags
# filter (non-array shape), and pagination cursors all map here.
INVALID_PARAMS = -32602

# Impl-defined server-error range, used for deliberate quota responses
# (NOT `-32603 InternalError`, which would mis-signal a quota response
# as a server fault).
RATE_LIMITED = -32004
RESPONSE_TOO_LARGE = -32005
