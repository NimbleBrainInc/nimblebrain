import { validateHostMeta } from "../bundles/manifest.ts";
import type { BundleManifest, HostManifestMeta } from "../bundles/types.ts";
import { hostProvidedCapabilityKeys } from "./capability.ts";

/**
 * Validate a bundle's `_meta["ai.nimblebrain/host"]` block at install
 * time. Two layered checks, both fatal:
 *
 * 1. **Schema validity.** Runs `validateHostMeta` against the JSON Schema
 *    (host_version enum, host_capabilities/host_version binding,
 *    additionalProperties:false on HostCapabilityRequirement). Catches
 *    typos like `requierd: true` that would silently let an "I require X"
 *    declaration degrade to "I prefer X" without anyone noticing — the
 *    exact failure mode the gate is supposed to prevent.
 *
 * 2. **Capability availability.** Every entry in `host_capabilities` with
 *    `required: true` must match a key the platform advertises in
 *    `ClientCapabilities.extensions`. The shape mirrors that
 *    advertisement: same key namespace, key-by-key intersection check.
 *
 * Bundles whose purpose depends on a host extension (e.g. a workspace
 * iterator requiring `ai.nimblebrain/host-resources`) fail loudly here
 * rather than mis-behave at runtime. Bundles that prefer a capability
 * but can adapt should list it with `required: false` (or omit
 * `required`) and check at runtime via the bundle SDK's availability
 * probe — degrading via structured tool errors.
 */
export function assertHostCapabilitiesAvailable(
  manifest: BundleManifest,
  bundleName: string,
): void {
  // 1. Schema validity. Single call site for the host-meta JSON Schema;
  //    without this the schema is decoration. validateHostMeta is a
  //    no-op when no host-meta block is present.
  const validation = validateHostMeta(manifest._meta);
  if (!validation.valid) {
    throw new Error(
      `Bundle "${bundleName}" has an invalid _meta["ai.nimblebrain/host"] block: ` +
        `${validation.errors.join("; ")}. Refusing to install.`,
    );
  }

  // 2. Capability availability — the policy check, post-schema.
  const hostMeta = manifest._meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  const declared = hostMeta?.host_capabilities ?? {};

  const required = Object.entries(declared)
    .filter(([, req]) => req?.required === true)
    .map(([key]) => key);
  if (required.length === 0) return;

  const provided = hostProvidedCapabilityKeys();
  const missing = required.filter((cap) => !provided.includes(cap));
  if (missing.length === 0) return;

  const providedLabel = provided.length > 0 ? provided.join(", ") : "(none)";
  throw new Error(
    `Bundle "${bundleName}" requires host capabilities not provided by this platform: ` +
      `${missing.join(", ")}. Refusing to install. Provided: ${providedLabel}.`,
  );
}
