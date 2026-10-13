/**
 * Test doubles for the WorkOS SDK client inside `WorkosIdentityProvider`.
 *
 * The provider talks to WorkOS only through `workos.userManagement`. A test
 * swaps the provider's private `workos` client for a stub whose
 * `userManagement` implements just the methods the test exercises, each typed
 * against the SDK's own signature. The builders return complete SDK objects, so
 * a fake's return value type-checks without reconstructing every field inline.
 */

import {
  type AuthenticationResponse,
  AutoPaginatable,
  type OrganizationMembership,
  type User,
  type WorkOS,
} from "@workos-inc/node";
import type { WorkosIdentityProvider } from "../../src/identity/providers/workos.ts";
import { stub } from "./stub.ts";

export type WorkosUserManagement = WorkOS["userManagement"];

type MembershipPage = Awaited<ReturnType<WorkosUserManagement["listOrganizationMemberships"]>>;

/**
 * Replace the provider's WorkOS client with one whose `userManagement` has only
 * `members`. Returns that `userManagement`, so a test can swap a method later.
 */
export function stubWorkosUserManagement(
  provider: WorkosIdentityProvider,
  members: Partial<WorkosUserManagement>,
): WorkosUserManagement {
  const userManagement = stub<WorkosUserManagement>(members);
  // biome-ignore lint/complexity/useLiteralKeys: workos is private; bracket access is TypeScript's typed path to it
  provider["workos"] = stub<WorkOS>({ userManagement });
  return userManagement;
}

/** The provider's current WorkOS `userManagement`, for swapping one method. */
export function workosUserManagement(provider: WorkosIdentityProvider): WorkosUserManagement {
  // biome-ignore lint/complexity/useLiteralKeys: workos is private; bracket access is TypeScript's typed path to it
  return provider["workos"].userManagement;
}

/** A complete WorkOS `User`; `id` and `email` are required, the rest default. */
export function workosUser(fields: Pick<User, "id" | "email"> & Partial<User>): User {
  const now = new Date().toISOString();
  return {
    object: "user",
    emailVerified: true,
    profilePictureUrl: null,
    name: null,
    firstName: null,
    lastName: null,
    lastSignInAt: null,
    locale: null,
    createdAt: now,
    updatedAt: now,
    externalId: null,
    metadata: {},
    ...fields,
  };
}

/** A complete active `OrganizationMembership` carrying the role `slug`. */
export function workosMembership(fields: {
  slug: string;
  userId?: string;
  organizationId?: string;
  id?: string;
}): OrganizationMembership {
  const now = new Date().toISOString();
  return {
    object: "organization_membership",
    id: fields.id ?? "om_test",
    userId: fields.userId ?? "user_test",
    organizationId: fields.organizationId ?? "org_test",
    organizationName: "Test Org",
    status: "active",
    role: { slug: fields.slug },
    directoryManaged: false,
    createdAt: now,
    updatedAt: now,
    customAttributes: {},
  };
}

/** One page of memberships, as `listOrganizationMemberships` resolves it. */
export function workosMembershipList(memberships: OrganizationMembership[]): MembershipPage {
  const page = { object: "list" as const, data: memberships, listMetadata: {} };
  return new AutoPaginatable(page, async () => page, {});
}

/** A complete `AuthenticationResponse`; the user and both tokens default. */
export function workosAuthentication(
  fields: Partial<AuthenticationResponse> = {},
): AuthenticationResponse {
  return {
    user: workosUser({ id: "user_test", email: "user@test.com" }),
    accessToken: "tok",
    refreshToken: "ref",
    ...fields,
  };
}
