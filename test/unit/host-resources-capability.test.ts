import { describe, expect, it } from "bun:test";
import {
  HOST_RESOURCES_CAPABILITY_KEY,
  HOST_RESOURCES_CAPABILITY_V1,
  HOST_RESOURCES_MAX_READ_SIZE,
  hostExtensions,
  hostProvidedCapabilityKeys,
} from "../../src/host-resources/index.ts";

// Phase 1 ground rules for the host-resources capability:
// - The key namespaces under `ai.nimblebrain/` (reverse-DNS of nimblebrain.ai;
//   matches the MCP extension naming convention).
// - Each operation is declared as an object, NOT a bare boolean. Future
//   sub-fields (`read.range`, `list.filter`, etc.) slot in without breaking
//   bundles that only check `enabled`.
// - v1 ships with `read.enabled: true, read.range: false`. A 10 MiB whole-file
//   cap holds until v2 adds range reads.
// - The exported `hostExtensions()` helper is the single source of truth for
//   what goes into `ClientCapabilities.extensions` on the wire.

describe("HOST_RESOURCES_CAPABILITY_KEY", () => {
  it("is the reverse-DNS NimbleBrain namespace key", () => {
    expect(HOST_RESOURCES_CAPABILITY_KEY).toBe("ai.nimblebrain/host-resources");
  });
});

describe("HOST_RESOURCES_CAPABILITY_V1", () => {
  it("declares read enabled with no range support in v1", () => {
    expect(HOST_RESOURCES_CAPABILITY_V1.read.enabled).toBe(true);
    expect(HOST_RESOURCES_CAPABILITY_V1.read.range).toBe(false);
  });

  it("caps whole-file reads at 10 MiB until v2 ships range reads", () => {
    expect(HOST_RESOURCES_CAPABILITY_V1.read.maxSize).toBe(10 * 1024 * 1024);
    expect(HOST_RESOURCES_CAPABILITY_V1.read.maxSize).toBe(HOST_RESOURCES_MAX_READ_SIZE);
  });

  it("declares list enabled", () => {
    expect(HOST_RESOURCES_CAPABILITY_V1.list.enabled).toBe(true);
  });

  it("declares write disabled in v1 (separate trust decision; future capability)", () => {
    expect(HOST_RESOURCES_CAPABILITY_V1.write.enabled).toBe(false);
  });

  it("allowlists the files:// URI scheme in v1", () => {
    expect(HOST_RESOURCES_CAPABILITY_V1.schemes).toEqual(["files"]);
  });

  it("uses object-shaped operations (not bare booleans) for forward-compat", () => {
    // If anyone refactors to `read: true` later, future sub-fields can't be
    // added without breaking bundle compatibility. Lock the shape now.
    expect(typeof HOST_RESOURCES_CAPABILITY_V1.read).toBe("object");
    expect(typeof HOST_RESOURCES_CAPABILITY_V1.list).toBe("object");
    expect(typeof HOST_RESOURCES_CAPABILITY_V1.write).toBe("object");
  });
});

describe("hostProvidedCapabilityKeys", () => {
  it("advertises exactly the host-resources key in Phase 1", () => {
    expect(hostProvidedCapabilityKeys()).toEqual([HOST_RESOURCES_CAPABILITY_KEY]);
  });

  it("is keyed for set-intersection use by the install gate", () => {
    const keys = hostProvidedCapabilityKeys();
    expect(keys.includes(HOST_RESOURCES_CAPABILITY_KEY)).toBe(true);
    expect(keys.includes("ai.nimblebrain/nonexistent")).toBe(false);
  });
});

describe("hostExtensions", () => {
  it("emits exactly the keyed object form expected by MCP ClientCapabilities.extensions", () => {
    // The shape is `Record<vendorKey, capabilityPayload>` — mirrors how the
    // platform advertises every extension and how the bundle's
    // host_capabilities declares its requirements.
    expect(hostExtensions()).toEqual({
      [HOST_RESOURCES_CAPABILITY_KEY]: HOST_RESOURCES_CAPABILITY_V1,
    });
  });

  it("references the same capability object — no defensive copy needed", () => {
    // Bundles read this through the SDK; serialization happens at the
    // transport boundary. Mutating the result would mutate the source, but
    // nothing in the runtime does that.
    expect(hostExtensions()[HOST_RESOURCES_CAPABILITY_KEY]).toBe(
      HOST_RESOURCES_CAPABILITY_V1,
    );
  });
});
