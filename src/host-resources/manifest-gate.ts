import type { BundleManifest, HostManifestMeta } from "../bundles/types.ts";
import { hostProvidedCapabilityKeys } from "./capability.ts";

/**
 * Enforce that the platform advertises every host capability the bundle
 * marks as required in `_meta["ai.nimblebrain/host"].host_capabilities`.
 * Throws when any entry with `required: true` references a capability the
 * platform does not advertise — install is refused.
 *
 * No silent fallback: bundles whose purpose depends on a host extension
 * (e.g. a workspace iterator requiring `ai.nimblebrain/host-resources`)
 * fail loudly here rather than mis-behave at runtime. Bundles that prefer
 * a capability but can adapt should list it with `required: false` (or
 * omit `required`) and check at runtime via the bundle SDK's availability
 * probe — degrading via structured tool errors.
 *
 * The shape mirrors the platform's `ClientCapabilities.extensions`
 * advertisement: same key namespace, key-by-key intersection check.
 */
export function assertHostCapabilitiesAvailable(
  manifest: BundleManifest,
  bundleName: string,
): void {
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
