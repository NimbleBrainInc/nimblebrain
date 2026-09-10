/**
 * The `secrets` block, and the one rule that makes it safe to put in git.
 *
 * `secrets.config` is opaque to the runtime, so the schema cannot say what a
 * backend's settings mean. It can say what they must never be: key material.
 * That rule is a schema keyword (`nbNoInlineKeyMaterial`), so it travels with
 * the published document rather than living in one caller.
 */

import { describe, expect, test } from "bun:test";
import { getValidator } from "../../../src/config/index.ts";

const validate = getValidator();

function errorsFor(config: unknown): string[] {
  validate(config);
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
}

function isValid(config: unknown): boolean {
  return validate(config) as boolean;
}

describe("the secrets block", () => {
  test("omitting it is valid — that is the default deployment", () => {
    expect(isValid({})).toBe(true);
  });

  test("accepts an empty block, a bare backend name, and a backend with config", () => {
    expect(isValid({ secrets: {} })).toBe(true);
    expect(isValid({ secrets: { backend: "file" } })).toBe(true);
    expect(
      isValid({ secrets: { backend: "file", config: { seal: { keyEnv: "NB_CREDENTIAL_KEY" } } } }),
    ).toBe(true);
  });

  test("accepts a name no build registers — the throw is the runtime's, not the schema's", () => {
    // The schema cannot know which backends this build registered, and a
    // deployment pinned to an older image would fail validation on a name its
    // successor understands. `createCredentialStore` is where an unknown name
    // becomes fatal.
    expect(isValid({ secrets: { backend: "vault" } })).toBe(true);
  });

  test("refuses an unknown member of the block", () => {
    validate({ secrets: { backend: "file", seal: true } });
    expect((validate.errors ?? []).some((e) => e.keyword === "additionalProperties")).toBe(true);
  });
});

describe("secrets.config never carries key material", () => {
  // A `secrets` block is ordinary configuration — commonly rendered from a
  // values file in version control — so a key written here is a key committed
  // to a repository. Each of these is a shape an operator reaches for when they
  // have the key in hand and the variable feels like a detour.
  const rejected: [string, unknown][] = [
    ["a top-level key", { key: "sk-live-abcdefghijklmnop" }],
    ["a nested key", { seal: { key: "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBrZXk=" } }],
    ["a vault token", { vault: { addr: "https://vault.example", token: "hvs.CAESIJ0abcdef" } }],
    ["a password", { db: { password: "correct-horse-battery" } }],
    ["a secret under a different case", { seal: { API_SECRET: "abcdefghijklmnop" } }],
    ["one inside an array", { rings: [{ keyMaterial: "abcdefghijklmnop" }] }],
    ["a key hiding in an `Env` name that is not a variable name", { seal: { keyEnv: "sk-live-x" } }],
  ];

  for (const [label, config] of rejected) {
    test(`rejects ${label}`, () => {
      expect(isValid({ secrets: { config } })).toBe(false);
    });
  }

  test("accepts the shapes that name a variable instead of holding one", () => {
    expect(isValid({ secrets: { config: { seal: { keyEnv: "NB_CREDENTIAL_KEY" } } } })).toBe(true);
    expect(isValid({ secrets: { config: { vault: { tokenEnv: "VAULT_TOKEN" } } } })).toBe(true);
    // Short values named `key` are modes and scheme names, not credentials.
    expect(isValid({ secrets: { config: { keyType: "aes" } } })).toBe(true);
    // Nothing that looks like key material at all.
    expect(isValid({ secrets: { config: { seal: { algorithm: "aes-256-gcm" } } } })).toBe(true);
  });

  test("the rejection names the path and never quotes the value", () => {
    const value = "sk-live-do-not-log-me";
    const messages = errorsFor({ secrets: { config: { seal: { key: value } } } });
    expect(messages.some((m) => m.includes("secrets.config.seal.key"))).toBe(true);
    // The error is about to be logged. Quoting the thing we are objecting to
    // would copy the key into the line the rejection produces.
    expect(messages.join("\n")).not.toContain(value);
  });

  test("the guard is on the config subtree, not on the rest of the file", () => {
    // `providers.anthropic.apiKey` is legitimately a literal (or a credential
    // reference). Widening the guard to the whole document would reject a
    // deployment that has always been valid.
    expect(isValid({ providers: { anthropic: { apiKey: "sk-ant-abcdefghijklmnop" } } })).toBe(true);
  });
});
