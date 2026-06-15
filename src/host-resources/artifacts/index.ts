import { ArtifactResolver } from "./artifact-resolver.ts";
import { ArtifactReadClient } from "./data-plane-read-client.ts";

export { ArtifactResolver, ArtifactTooLargeError } from "./artifact-resolver.ts";
export {
  ARTIFACT_URI_SCHEME,
  artifactIdToUri,
  InvalidArtifactUriError,
  isArtifactUri,
  uriToArtifactId,
} from "./artifact-uri.ts";
export {
  ArtifactNotFoundError,
  ArtifactReadClient,
  ArtifactReadError,
} from "./data-plane-read-client.ts";

/**
 * Process-wide default `artifact://` resolver. Lazily constructed so a runtime
 * with no data-plane wiring (NB_ARTIFACTS_DATA_PLANE_URL absent) never reads the
 * provisioning env until an `artifact://` reference is actually resolved — at
 * which point a missing var fails with a named cause. Tests inject their own
 * resolver via {@link setArtifactResolver}.
 */
let resolver: ArtifactResolver | undefined;

export function getArtifactResolver(): ArtifactResolver {
  if (!resolver) {
    resolver = new ArtifactResolver(new ArtifactReadClient());
  }
  return resolver;
}

/** Override the default resolver (test seam). Pass `undefined` to reset. */
export function setArtifactResolver(next: ArtifactResolver | undefined): void {
  resolver = next;
}
