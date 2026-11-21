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
  orgRole: "admin",
  preferences: {},
};

// ── DevIdentityProvider ──────────────────────────────────────────

/**
 * The `dev` adapter (`{"auth":{"adapter":"dev"}}` in `instance.json`): every
 * request authenticates as `DEV_IDENTITY`, with no credential checked.
 * Creates the default user profile on first access if missing.
 *
 * The id, email, and org role are fixed, so the developer stays the admin
 * whatever the stored record says. The display name and preferences come from
 * the stored profile on every request, because `set_preferences` writes them
 * there and the prompt, the model choice, and the web app read them off the
 * identity.
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    // Dev mode has no auth at all, so nothing to discover.
    authorizationServer: false,
  };

  /** The profile seed, shared by every request that arrives while it runs. */
  private seeded: Promise<void> | null = null;

  constructor(
    _workDir: string,
    private userStore: UserStore,
  ) {
    log.warn(
      "instance.json selects the dev identity provider: every request is the local developer, with no login",
    );
  }

  async verifyRequest(_req: Request): Promise<VerifiedIdentity | null> {
    await this.ensureUserProfile();
    const profile = await this.readProfile();
    return {
      ...DEV_IDENTITY,
      displayName: profile?.displayName || DEV_IDENTITY.displayName,
      preferences: profile?.preferences ?? DEV_IDENTITY.preferences,
      grant: FIRST_PARTY_GRANT,
    };
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

  /**
   * The stored dev profile, or null when it is missing or unreadable. Once the
   * provider has initialized, a corrupt `profile.json` falls back to the
   * defaults rather than failing every request; `seedUserProfile` still reads
   * it unguarded on the first request.
   */
  private async readProfile(): Promise<User | null> {
    try {
      return await this.userStore.get(DEV_IDENTITY.id);
    } catch (err) {
      log.warn("[dev] could not read the dev user profile; using defaults", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Seed the dev user profile once per provider. Concurrent first requests
   * share one seed, and the seed goes through `UserStore.create`, which writes
   * by temp file and rename, so a request reading `profile.json` meanwhile
   * sees no file or the whole record, never a truncated one. A failed seed is
   * forgotten, so the next request tries again.
   */
  private ensureUserProfile(): Promise<void> {
    this.seeded ??= this.seedUserProfile().catch((err: unknown) => {
      this.seeded = null;
      throw err;
    });
    return this.seeded;
  }

  private async seedUserProfile(): Promise<void> {
    if (await this.userStore.get(DEV_IDENTITY.id)) return;
    await this.userStore.create({
      id: DEV_IDENTITY.id,
      email: DEV_IDENTITY.email,
      displayName: DEV_IDENTITY.displayName,
      orgRole: DEV_IDENTITY.orgRole,
    });
  }
}
