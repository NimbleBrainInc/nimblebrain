import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../observability/log.ts";
import {
  type CreateUserInput,
  type CreateUserResult,
  FIRST_PARTY_GRANT,
  type IdentityProvider,
  type ProviderCapabilities,
  type UserIdentity,
  type VerifiedIdentity,
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
 * The `dev` adapter (`{"auth":{"adapter":"dev"}}` in `instance.json`): every
 * request authenticates as `DEV_IDENTITY`, with no credential checked.
 * Creates the default user profile on first access if missing.
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    // Dev mode has no auth at all, so nothing to discover.
    authorizationServer: false,
  };

  private initialized = false;
  private usersDir: string;

  constructor(
    workDir: string,
    private userStore: UserStore,
  ) {
    this.usersDir = join(workDir, "users");
    log.warn(
      "instance.json selects the dev identity provider: every request is the local developer, with no login",
    );
  }

  async verifyRequest(_req: Request): Promise<VerifiedIdentity | null> {
    await this.ensureUserProfile();
    return { ...DEV_IDENTITY, grant: FIRST_PARTY_GRANT };
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

  /** The built-in developer is the owner every request runs as. */
  isConfiguredOwner(user: Pick<User, "id" | "email">): boolean {
    return user.id === DEV_IDENTITY.id;
  }

  // ── Private ───────────────────────────────────────────────────

  /**
   * Seed the dev user profile on first call. Profile creation doesn't need
   * to repeat per request — user identity for dev mode is fixed — so the
   * `initialized` gate stays here. Workspace provisioning is handled by
   * verifyRequest directly so it self-heals.
   */
  private async ensureUserProfile(): Promise<void> {
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

    this.initialized = true;
  }
}
