/**
 * Signing in: the runtime answers its health check, refuses a caller with no
 * credential, and tells a signed-in person who they are and where they work.
 */

import { expect, expectEq, type Scenario } from "../scenario.ts";

export const sessionBootstrap: Scenario = {
  id: "session.bootstrap",
  title: "Health, a refused anonymous caller, the signed-in person's bootstrap",
  groups: ["smoke"],
  async run(t) {
    await t.check("the health check answers ok without sign-in", async () => {
      const r = await t.client.rest(null, "GET", "/v1/health");
      expectEq(r.status, 200, "status");
      expectEq((r.json as { status?: string } | undefined)?.status, "ok", "status field");
      return r.json;
    });

    await t.check("bootstrap without a credential is 401", async () => {
      const r = await t.client.rest(null, "GET", "/v1/bootstrap");
      expectEq(r.status, 401, "status");
      return { status: r.status };
    });

    await t.check("bootstrap names the caller, their workspaces, chat and models", async () => {
      const boot = await t.client.bootstrap(t.alice);
      expect(boot.user.id, "the caller", boot.user);
      expect(
        boot.workspaces.some((w) => w.id === t.ws),
        "the workspace is listed",
        boot.workspaces,
      );
      // `config.chat` is false only when nothing binds conversations.
      expect(boot.config.chat !== false, "chat is not off", boot.config);
      expect(
        typeof boot.config.models?.default === "string",
        "a default model slot",
        boot.config.models,
      );
      return { user: boot.user.id, workspaces: boot.workspaces.length, models: boot.config.models };
    });
  },
};
