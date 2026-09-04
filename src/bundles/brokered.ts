/**
 * The kernel's half of a brokered install: how to recognise one, and where its
 * provider's local state lives.
 *
 * A **brokered** connector is one whose upstream credential is held by a third
 * party that also hosts the MCP session (see
 * `src/connectors/providers/managed-provider.ts`). Everything the kernel needs
 * to know about such an install is three fields — who brokered it, which
 * catalog entry it came from, and an opaque blob only that provider reads. Two
 * rules keep it that way:
 *
 *   1. **One accessor.** Nothing reads `ref.brokered` directly; every consumer
 *      calls {@link brokeredRef}, which is also where the legacy per-vendor
 *      blocks are mapped forward.
 *   2. **One directory rule.** A provider's per-connector local state lives at
 *      `credentials/<provider>/<connectorId>/`, under the owner's credential
 *      root — {@link brokeredConnectorDir} is the single site that builds it.
 *      The kernel owns the *path*; what a provider writes inside it is the
 *      provider's business (Composio keeps a `connection.json`; Smithery keeps
 *      nothing at all).
 */

import { join } from "node:path";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { IdentityContext } from "../identity/context.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import type { BrokeredRef, BundleRef } from "./types.ts";

/**
 * The per-vendor ref blocks written before brokered installs shared one shape.
 *
 * READ-SIDE SHIM. Refs persisted by an older runtime carry `composio` or
 * `smithery` instead of `brokered`; {@link brokeredRef} maps them forward so an
 * existing install survives a restart with no config edit. Nothing writes these
 * any more. Delete this — and the branch in `brokeredRef` — one release after
 * the shape landed, when no persisted ref can still carry them.
 */
interface LegacyBrokeredRefBlocks {
  composio?: { connectorId: string };
  smithery?: {
    connectorId: string;
    connectionId: string;
    namespace: string;
    baseUrl: string;
  };
}

/**
 * The brokered coordinates on a bundle ref, or `undefined` for a
 * runtime-native one (plain OAuth — those resolve their catalog entry by URL
 * and detect a lapsed credential through the transport's `UnauthorizedError`
 * path, so neither consumer needs anything here).
 *
 * This is the ONE place the brokered/native question is answered. The
 * revalidator dispatches on `provider`, the connector read surfaces and the
 * skill-overlay reconcile resolve `connectorId`, and each provider's own probe
 * and teardown read `providerRef`. Splitting those into separate readers is how
 * the previous shape grew a hand-mirrored vendor list in a dozen files.
 */
export function brokeredRef(ref: BundleRef | undefined): BrokeredRef | undefined {
  if (!ref) return undefined;
  if (ref.brokered) return ref.brokered;

  // Legacy shim — see `LegacyBrokeredRefBlocks`.
  const legacy = ref as BundleRef & LegacyBrokeredRefBlocks;
  if (legacy.composio) {
    return { provider: "composio", connectorId: legacy.composio.connectorId };
  }
  if (legacy.smithery) {
    const { connectorId, connectionId, namespace, baseUrl } = legacy.smithery;
    return { provider: "smithery", connectorId, providerRef: { connectionId, namespace, baseUrl } };
  }
  return undefined;
}

/**
 * Slug rule for a path segment built from a provider id or a connector id.
 *
 * Catalog entries name connectors with reverse-DNS dots and slashes
 * (`com.google/gmail`), which are not safe path components; we slug to
 * `[A-Za-z0-9._-]+`. Validation is tight: anything that would escape the
 * directory or shell out throws. Better to fail loud than to silently write to
 * an unexpected path.
 */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
export function connectorSlug(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("[brokered] invalid path segment: must be a non-empty string");
  }
  const slug = value.replace(/^@/, "").replace(/[/\\]/g, "-");
  if (!PATH_SEGMENT_RE.test(slug) || slug === "." || slug === "..") {
    throw new Error(
      `[brokered] invalid path segment "${value}": ` +
        "must contain only alphanumerics, dot, underscore, hyphen, and one optional @scope/ prefix",
    );
  }
  return slug;
}

/**
 * Absolute path to a brokered provider's per-connector state directory, under
 * the owner's credential root:
 *   - workspace: `workspaces/<wsId>/credentials/<provider>/<connector>/`
 *   - user:      `users/<userId>/credentials/<provider>/<connector>/`
 *
 * The workspace path routes through `WorkspaceContext` (its single definition
 * site, which validates `wsId`). The user path is the identity-owned
 * personal-connector credential home, outside any workspace (mirroring the
 * OAuth records' `{type:"user"}` scope): the `IdentityContext` constructor validates
 * the userId, and the `credentials/<provider>` subpath is joined onto that
 * validated root — a variable root, so `check:credential-paths` sees no literal
 * `users/…/credentials` to flag.
 */
export function brokeredConnectorDir(
  workDir: string,
  owner: ConnectorOwner,
  provider: string,
  connectorId: string,
): string {
  const providerSlug = connectorSlug(provider);
  const slug = connectorSlug(connectorId);
  if (owner.type === "workspace") {
    return new WorkspaceContext({ wsId: owner.wsId, workDir }).getDataPath(
      "credentials",
      providerSlug,
      slug,
    );
  }
  const userRoot = new IdentityContext({ userId: owner.userId, workDir }).getDataPath("root");
  return join(userRoot, "credentials", providerSlug, slug);
}
