/**
 * The people a booted runtime knows, each signed in by a bearer token.
 *
 * `alice` is an org admin, `bob` an org member. Each is provisioned in the
 * runtime's user store on first use, as a production provider's users are.
 */

import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  TokenGrant,
  VerifiedIdentity,
} from "../../src/identity/provider.ts";
import type { User, UserStore } from "../../src/identity/user.ts";

export interface Person {
  id: string;
  email: string;
  displayName: string;
  orgRole: "admin" | "member";
  token: string;
}

export const ALICE: Person = {
  id: "usr_e2e_alice",
  email: "alice@example.test",
  displayName: "Alice Example",
  orgRole: "admin",
  token: "e2e-token-alice",
};

export const BOB: Person = {
  id: "usr_e2e_bob",
  email: "bob@example.test",
  displayName: "Bob Example",
  orgRole: "member",
  token: "e2e-token-bob",
};

/** First-party grant: a signed-in person of this deployment. */
const FIRST_PARTY: TokenGrant = { kind: "first_party" };

export class TokenIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    authorizationServer: false,
  };

  private readonly seeded = new Map<string, Promise<void>>();

  constructor(
    private readonly userStore: UserStore,
    private readonly people: readonly Person[] = [ALICE, BOB],
  ) {}

  async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const header = req.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    const person = this.people.find((p) => p.token === header.slice(7));
    if (!person) return null;
    await this.seed(person);
    const stored = await this.userStore.get(person.id).catch(() => null);
    return {
      id: person.id,
      email: person.email,
      displayName: stored?.displayName || person.displayName,
      orgRole: person.orgRole,
      preferences: stored?.preferences ?? {},
      grant: FIRST_PARTY,
    };
  }

  private seed(person: Person): Promise<void> {
    let pending = this.seeded.get(person.id);
    if (!pending) {
      pending = (async () => {
        if (await this.userStore.get(person.id)) return;
        await this.userStore.create({
          id: person.id,
          email: person.email,
          displayName: person.displayName,
          orgRole: person.orgRole,
        });
      })();
      this.seeded.set(person.id, pending);
    }
    return pending;
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
}
