/**
 * The dev provider seeds `users/usr_default/profile.json` on its first
 * request, and concurrent first requests must all authenticate.
 *
 * A plain `writeFile` opens the target with `O_TRUNC` before it writes, so a
 * request reading the profile in that window parses an empty file
 * (`JSON Parse error: Unexpected EOF`) and fails authentication with a 500.
 * The test holds a write to the target between the truncate and the bytes,
 * which is that window made deterministic, and starts a second request in it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../../../src/observability/log.ts";

const real = { ...realFs };

/** Set while a test wants writes to `heldPath` held after their truncate. */
let held: {
  path: string;
  truncated: () => void;
  release: Promise<void>;
} | null = null;

mock.module("node:fs/promises", () => ({
  ...real,
  writeFile: async (...args: Parameters<typeof realFs.writeFile>) => {
    const [path, data, options] = args;
    const hold = held;
    if (hold && path === hold.path) {
      held = null;
      await real.writeFile(path, "", options);
      hold.truncated();
      await hold.release;
    }
    return real.writeFile(path, data, options);
  },
}));

afterAll(() => {
  mock.module("node:fs/promises", () => real);
});

const { DEV_IDENTITY, DevIdentityProvider } = await import(
  "../../../src/identity/providers/dev.ts"
);
const { UserStore } = await import("../../../src/identity/user.ts");

let workDir: string;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  workDir = await real.mkdtemp(join(tmpdir(), "nb-dev-seed-test-"));
  warnSpy = spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  held = null;
  warnSpy.mockRestore();
  await real.rm(workDir, { recursive: true, force: true });
});

describe("DevIdentityProvider profile seed", () => {
  test("a request arriving mid-seed authenticates", async () => {
    const profilePath = join(workDir, "users", DEV_IDENTITY.id, "profile.json");
    const adapter = new DevIdentityProvider(workDir, new UserStore(workDir));

    let release!: () => void;
    let truncated!: () => void;
    const truncatedOnce = new Promise<void>((resolve) => {
      truncated = resolve;
    });
    held = {
      path: profilePath,
      truncated,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const first = adapter.verifyRequest(new Request("http://localhost/a"));
    // A seed that writes the target in place is now held between its truncate
    // and its bytes. A seed that never writes the target in place finishes.
    await Promise.race([truncatedOnce, first]);

    // The second request settles before the held write is released, so it
    // reads whatever a reader can see mid-seed.
    const second = await adapter
      .verifyRequest(new Request("http://localhost/b"))
      .finally(() => release());
    expect(second?.id).toBe(DEV_IDENTITY.id);
    expect((await first)?.id).toBe(DEV_IDENTITY.id);

    const stored = JSON.parse(await real.readFile(profilePath, "utf-8"));
    expect(stored.id).toBe(DEV_IDENTITY.id);
  });

  test("concurrent first requests seed the profile once", async () => {
    const userStore = new UserStore(workDir);
    const create = spyOn(userStore, "create");
    const adapter = new DevIdentityProvider(workDir, userStore);

    const identities = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        adapter.verifyRequest(new Request(`http://localhost/${i}`)),
      ),
    );

    for (const identity of identities) expect(identity?.id).toBe(DEV_IDENTITY.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await userStore.list()).toHaveLength(1);
  });
});
