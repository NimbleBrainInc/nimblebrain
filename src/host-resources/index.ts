export type {
  HostResourcesCapability,
  HostResourcesListCapability,
  HostResourcesReadCapability,
  HostResourcesWriteCapability,
} from "./capability.ts";
export {
  HOST_RESOURCES_CAPABILITY_KEY,
  HOST_RESOURCES_CAPABILITY_V1,
  HOST_RESOURCES_MAX_READ_SIZE,
  hostExtensions,
  hostProvidedCapabilityKeys,
} from "./capability.ts";
export { assertHostCapabilitiesAvailable } from "./manifest-gate.ts";
