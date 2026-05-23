/**
 * Host-resources extension capability.
 *
 * Advertised by the platform (acting as MCP Client to each bundle) in the
 * `extensions` block of the `initialize` handshake. `extensions` is MCP's
 * standardized vendor-capability mechanism (see
 * https://modelcontextprotocol.io/extensions/overview); vendors use
 * reverse-DNS keys (`ai.nimblebrain/...` for nimblebrain.ai) to avoid
 * collisions. Bundles read this to decide whether to use the
 * `ai.nimblebrain/resources/{read,list}` extension methods or fall back to
 * inline-content tool arguments.
 *
 * Phase 1 advertises the capability and gates installs on
 * `host_capabilities` entries marked `required: true`. Inbound request
 * handlers ship in Phase 2.
 *
 * Each operation is declared as an object (not a bare boolean) so future
 * sub-fields (`read.range`, `read.unit`, `list.filter`, etc.) slot in without
 * a breaking change. Bundles check `caps.read.enabled` for "can I read?" and
 * `caps.read.range` for the v2 range-read sub-capability.
 */

export const HOST_RESOURCES_CAPABILITY_KEY = "ai.nimblebrain/host-resources" as const;

/** v1 cap on whole-file reads (lifts to unbounded when `read.range` is true in v2). */
export const HOST_RESOURCES_MAX_READ_SIZE = 10 * 1024 * 1024; // 10 MiB

export interface HostResourcesReadCapability {
  enabled: boolean;
  /** v2: bounded `offset`/`length` reads. */
  range: boolean;
  /** Whole-response byte cap. Bundles exceeding this get -32005 ResponseTooLarge. */
  maxSize: number;
}

export interface HostResourcesListCapability {
  enabled: boolean;
}

export interface HostResourcesWriteCapability {
  enabled: boolean;
}

export interface HostResourcesCapability {
  read: HostResourcesReadCapability;
  list: HostResourcesListCapability;
  write: HostResourcesWriteCapability;
  /** URI scheme allowlist. Bundles requesting URIs outside this set get -32602. */
  schemes: string[];
}

export const HOST_RESOURCES_CAPABILITY_V1: HostResourcesCapability = {
  read: {
    enabled: true,
    range: false,
    maxSize: HOST_RESOURCES_MAX_READ_SIZE,
  },
  list: {
    enabled: true,
  },
  write: {
    enabled: false,
  },
  schemes: ["files"],
};

/**
 * Keys of all host-provided capabilities this platform build advertises.
 * Used by the install-time manifest gate to validate the keys in a
 * bundle's `_meta["ai.nimblebrain/host"].host_capabilities` block (the
 * subset with `required: true`).
 */
export function hostProvidedCapabilityKeys(): readonly string[] {
  return [HOST_RESOURCES_CAPABILITY_KEY];
}

/**
 * Payload added to ClientCapabilities.extensions in McpSource initialize.
 * Inlined here so both Client construction sites in mcp-source.ts share one
 * source of truth. `extensions` is the spec-blessed location for
 * vendor-namespaced capability declarations — not the older `experimental`
 * field, which is kept by the SDK for backward compatibility.
 */
export function hostExtensions(): Record<string, object> {
  return {
    [HOST_RESOURCES_CAPABILITY_KEY]: HOST_RESOURCES_CAPABILITY_V1,
  };
}
