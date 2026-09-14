import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../src/engine/types.ts";
import {
  credentialScopeLabel,
  FileCredentialStore,
} from "../../src/tools/credential-store.ts";
import {
  describeCredentialStoreConformance,
  INSTANCE,
  READ,
  USER,
  WS,
} from "../helpers/credential-store-conformance.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

function freshStore(): {
  store: FileCredentialStore;
  dir: string;
  events: EngineEvent[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-credstore-"));
  seedWorkspaceRoot(dir, "ws_test");
  const events: EngineEvent[] = [];
  const store = new FileCredentialStore(dir, { eventSink: { emit: (e) => events.push(e) } });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describeCredentialStoreConformance("FileCredentialStore", freshStore);

// What is true of the files specifically, and of no other backend: the modes,
// the three roots as paths, and the temp-file naming a killed `put` leaves
// behind. These stay true under an encrypting backend — sealing changes the
// bytes in the file, not the file mechanics — which is why they are a second
// block rather than a fork of the suite above.
describe("FileCredentialStore — on-disk mechanics", () => {
  test("put writes file with mode 0o600 and parent dir 0o700", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put(WS, "k1", "v1");
      const filePath = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k1");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      const dirPath = join(dir, "workspaces", "ws_test", "credentials", "secrets");
      expect(statSync(dirPath).mode & 0o777).toBe(0o700);
    } finally {
      cleanup();
    }
  });

  // The three roots, asserted as paths so a refactor that collapsed two of them
  // into one directory fails here and not in production. The values being
  // independent is the interface half and lives in the conformance block.
  test("the three scopes are three roots on disk", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put(INSTANCE, "acme.db_url", "instance-value");
      await store.put(WS, "acme.db_url", "workspace-value");
      await store.put(USER, "acme.db_url", "user-value");

      expect(statSync(join(dir, "credentials", "secrets", "acme.db_url")).isFile()).toBe(true);
      expect(
        statSync(
          join(dir, "workspaces", "ws_test", "credentials", "secrets", "acme.db_url"),
        ).isFile(),
      ).toBe(true);
      expect(
        statSync(
          join(dir, "users", "usr_alex01", "credentials", "secrets", "acme.db_url"),
        ).isFile(),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  // The temp name a `put` writes to is dot-prefixed precisely so it falls
  // outside the key grammar. Were it named `<key>.tmp.<hex>` the grammar would
  // accept it, and a `put` killed between write and rename would leave an
  // operator staring at a key that is not one.
  test("a temp file left by a killed put is not listed as a key", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put(WS, "acme.db_url", "v");
      const secretsDir = join(dir, "workspaces", "ws_test", "credentials", "secrets");
      writeFileSync(join(secretsDir, ".acme.db_url.tmp.a1b2c3d4"), "half-written");
      expect((await store.list(WS)).map((k) => k.key)).toEqual(["acme.db_url"]);
    } finally {
      cleanup();
    }
  });

  // The legacy plaintext path only. It is lossy — a value that genuinely ends
  // in a newline comes back without it, and this path cannot tell that from an
  // `echo "secret" > file` — and sealing is what repairs it. The other half of
  // the split is in `credential-store-sealed.test.ts`.
  test("trailing newline on an unsealed value is trimmed on read", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.put(WS, "k", "value\n");
      expect((await store.get(WS, "k", READ))?.reveal()).toBe("value");
    } finally {
      cleanup();
    }
  });
});

describe("credentialScopeLabel", () => {
  test("names the owner", () => {
    expect(credentialScopeLabel(INSTANCE)).toBe("instance");
    expect(credentialScopeLabel(WS)).toBe("workspace:ws_test");
    expect(credentialScopeLabel(USER)).toBe("user:usr_alex01");
  });
});
