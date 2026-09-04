# 0032. The provider-typed blocks on persisted connector state

- Status: Proposed
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

ADR-0026 put the brokered *verbs* behind one seam: create a session, initiate,
connect a key, probe, mount routes. The *nouns* did not follow it.

Persisted connector state still carries a typed block per brokered vendor
(`BundleRef`, `src/bundles/types.ts`) — tenant state shaped like a particular
vendor's coordinates. The connector `auth-kind` taxonomy is a closed union with a
literal per vendor, mirrored by hand in the seam, the wire `ServerDetail`, the
catalog projection, and the registry types. Reaching a persisted block from a
probe target is an open-coded arm per vendor. And the credential directory, the
uninstall path, the disconnect path, the boot state probe, and the identity
teardown each carry a vendor arm.

The seam already declares the field this should ride on.
`ManagedSession.providerRef` carries opaque provider-scoped coordinates, and its
own note records the gap: opaque *to the seam*, not to the runtime, because the
install path validates the fields its provider's block declares and lands them in
a typed shape. So carrying a value is done and carrying a schema is not.

The evidence that this costs something is that adding a second brokered provider
touched twelve files outside its own folder — none of which are about that
provider.

## Options

**A. One brokered block.** Replace the per-vendor typed blocks with a single
`{ provider, connectorId, providerRef }`, where `provider` is the registered
provider id and `providerRef` is the seam's value verbatim. Opens the auth-kind
union to a string keyed into the provider registry, the way the registry type
already opened for sources (ADR-0020). Every vendor arm becomes a registry
lookup. Cost: a persisted-state migration for existing installs, and the kernel
loses static knowledge of what a block contains — which is the point, and also
means a malformed block fails at use rather than at load.

**B. One block, with per-provider validation at the boundary.** As A, but each
provider declares a schema the install path validates `providerRef` against, so
a malformed block is refused where it is written rather than where it is read.
Keeps the kernel free of vendor shapes while keeping the failure early. Cost: a
schema registry, and the seam grows a second thing providers must supply.

**C. Keep the typed blocks; collapse only the dispatch arms.** Leave persisted
state alone and remove the duplication in probe, uninstall, disconnect, and boot
by routing through the provider registry. Smaller and non-migrating; leaves the
closed enum and its four hand-mirrored copies in place.

**D. Leave it.** Two brokered providers is not many, and the duplication is
visible rather than subtle.

## What would decide it

- **Whether a third brokered provider is coming.** The cost is per-provider and
  paid at integration time. With no third provider in prospect, D is defensible;
  with one, A or B pays for itself immediately.
- **How many of the twelve files a third provider would touch under each
  option.** This is countable ahead of time by walking the second provider's
  diff against each option, and it is the most direct measurement available.
- **Whether the four hand-mirrored copies of the auth-kind enum have ever
  disagreed.** A copy that has drifted is evidence the mirroring does not hold;
  one that has not is evidence the cost is bounded.
- **What the migration actually costs.** Persisted refs exist in every tenant
  workspace record. Whether A can be done as a read-time projection over the old
  shapes — rather than a write migration — decides how much of the objection to
  A is real.
- **Whether opacity loses anything the kernel needs.** Walk the reads of the
  typed blocks: any place the kernel makes a decision on a vendor-shaped field is
  either a bug in the seam or a genuine requirement that A would have to answer.
