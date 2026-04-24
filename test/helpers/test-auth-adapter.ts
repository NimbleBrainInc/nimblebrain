/**
 * In-memory IdentityProvider for tests.
 *
 * Validates Bearer tokens via simple string comparison (no bcrypt).
 * Provisions a default user profile and workspace on first successful auth
 * (same pattern as DevIdentityProvider) so workspace resolution doesn't fail.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IdentityProvider,
  UserIdentity,
  ProviderCapabilities,
  CreateUserInput,
  CreateUserResult,
} from "../../src/identity/provider.ts";
import type { User, UserStore } from "../../src/identity/user.ts";
import type { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

export const TEST_IDENTITY: UserIdentity = {
  id: "usr_test",
  email: "test@example.com",
  displayName: "Test User",
  orgRole: "owner",
};

export class TestAuthAdapter implements IdentityProvider {
  private initPromise?: Promise<void>;

  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
  };

  constructor(
    private apiKey: string,
    private userStore?: UserStore,
    private workspaceStore?: WorkspaceStore,
    private workDir?: string,
  ) {}

  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);
    if (token !== this.apiKey) return null;
    await this.ensureDefaults();
    return TEST_IDENTITY;
  }

  async listUsers(): Promise<User[]> {
    return [];
  }

  async createUser(data: CreateUserInput): Promise<CreateUserResult> {
    const now = new Date().toISOString();
    const user: User = {
      id: `usr_${Date.now()}`,
      email: data.email,
      displayName: data.displayName,
      orgRole: data.orgRole ?? "member",
      preferences: {},
      createdAt: now,
      updatedAt: now,
    };
    return { user };
  }

  async deleteUser(_userId: string): Promise<boolean> {
    return false;
  }

  private ensureDefaults(): Promise<void> {
    // Single-flight: concurrent requests share one in-flight promise so we
    // don't double-provision the user/workspace. Without this, parallel
    // authenticated requests all race past the init check and multiple
    // addMember() calls collide on MemberConflictError.
    if (!this.initPromise) {
      this.initPromise = this.doEnsureDefaults();
    }
    return this.initPromise;
  }

  private async doEnsureDefaults(): Promise<void> {
    if (!this.userStore || !this.workspaceStore) return;

    const existingUser = await this.userStore.get(TEST_IDENTITY.id);
    if (!existingUser) {
      const now = new Date().toISOString();
      const user: User = {
        id: TEST_IDENTITY.id,
        email: TEST_IDENTITY.email,
        displayName: TEST_IDENTITY.displayName,
        orgRole: TEST_IDENTITY.orgRole,
        preferences: {},
        createdAt: now,
        updatedAt: now,
      };

      if (this.workDir) {
        const userDir = join(this.workDir, "users", TEST_IDENTITY.id);
        if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });
        await writeFile(join(userDir, "profile.json"), `${JSON.stringify(user, null, 2)}\n`, "utf-8");
      }
    }

    const workspaces = await this.workspaceStore.list();
    if (workspaces.length === 0) {
      const ws = await this.workspaceStore.create("Default", "default");
      await this.workspaceStore.addMember(ws.id, TEST_IDENTITY.id, "admin");
    } else {
      // Ensure test user is a member of the first workspace
      const ws = workspaces[0]!;
      const isMember = ws.members.some((m) => m.userId === TEST_IDENTITY.id);
      if (!isMember) {
        await this.workspaceStore.addMember(ws.id, TEST_IDENTITY.id, "admin");
      }
    }
  }
}

/**
 * Create a TestAuthAdapter wired to a runtime's stores for workspace provisioning.
 */
export function createTestAuthAdapter(
  apiKey: string,
  runtime: { getUserStore(): UserStore; getWorkspaceStore(): WorkspaceStore; getWorkDir(): string },
): TestAuthAdapter {
  return new TestAuthAdapter(apiKey, runtime.getUserStore(), runtime.getWorkspaceStore(), runtime.getWorkDir());
}
