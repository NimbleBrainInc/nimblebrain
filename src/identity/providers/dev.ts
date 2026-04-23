import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureUserWorkspace } from "../../workspace/provisioning.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../provider.ts";
import type { User, UserStore } from "../user.ts";

// ── Default dev identity ──────────────────────────────────────────

export const DEV_IDENTITY: UserIdentity = {
  id: "usr_default",
  email: "dev@localhost",
  displayName: "Developer",
  orgRole: "owner",
  preferences: {},
};

// ── DevIdentityProvider ──────────────────────────────────────────

/**
 * Identity provider for dev mode — always returns a default user identity.
 * Creates the default user profile and workspace on first access if missing.
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
  };

  private initialized = false;
  private usersDir: string;
  private workspaceStore: WorkspaceStore;

  constructor(
    workDir: string,
    private userStore: UserStore,
    workspaceStore: WorkspaceStore,
  ) {
    this.usersDir = join(workDir, "users");
    this.workspaceStore = workspaceStore;
    console.warn("Running in dev mode — no authentication configured");
  }

  async verifyRequest(_req: Request): Promise<UserIdentity | null> {
    await this.ensureDefaults();
    return DEV_IDENTITY;
  }

  async listUsers(): Promise<User[]> {
    return this.userStore.list();
  }

  async createUser(data: CreateUserInput): Promise<CreateUserResult> {
    const user = await this.userStore.create({
      email: data.email,
      displayName: data.displayName,
      orgRole: data.orgRole,
    });
    return { user };
  }

  async deleteUser(userId: string): Promise<boolean> {
    return this.userStore.delete(userId);
  }

  // ── Private ───────────────────────────────────────────────────

  private async ensureDefaults(): Promise<void> {
    if (this.initialized) return;

    const existingUser = await this.userStore.get(DEV_IDENTITY.id);
    if (!existingUser) {
      const now = new Date().toISOString();
      const user: User = {
        id: DEV_IDENTITY.id,
        email: DEV_IDENTITY.email,
        displayName: DEV_IDENTITY.displayName,
        orgRole: DEV_IDENTITY.orgRole,
        preferences: {},
        createdAt: now,
        updatedAt: now,
      };

      const userDir = join(this.usersDir, DEV_IDENTITY.id);
      if (!existsSync(userDir)) {
        mkdirSync(userDir, { recursive: true });
      }
      await writeFile(join(userDir, "profile.json"), `${JSON.stringify(user, null, 2)}\n`, "utf-8");
    }

    // Ensure the dev user has at least one workspace. Establishes the
    // invariant "authenticated user has ≥1 workspace" at the identity
    // boundary. Idempotent — no-op after first call.
    await ensureUserWorkspace(this.workspaceStore, {
      id: DEV_IDENTITY.id,
      displayName: DEV_IDENTITY.displayName,
    });

    this.initialized = true;
  }
}
