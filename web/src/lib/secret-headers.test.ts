import { describe, expect, test } from "bun:test";
import type { DirectoryEntry } from "../api/client";
import { labelForCredentialKey, secretHeaderFields } from "./secret-headers";

/**
 * A remote-oauth install descriptor carrying an arbitrary `secretHeaders` block.
 * Untyped on purpose: the point of several cases below is a block the server
 * type forbids but a miscurated catalog can still put on the wire.
 */
function install(
  secretHeaders?: Record<string, unknown>,
  auth = "provider",
): DirectoryEntry["install"] {
  return {
    kind: "remote-oauth",
    url: "https://mcp.example.test/mcp",
    transportType: "streamable-http",
    auth,
    ...(secretHeaders ? { secretHeaders } : {}),
  } as DirectoryEntry["install"];
}

describe("labelForCredentialKey", () => {
  test("uses the last dotted segment — the leading ones namespace, they don't describe", () => {
    expect(labelForCredentialKey("acme.db_url")).toBe("Database URL");
    expect(labelForCredentialKey("vendor.acme.api_key")).toBe("API Key");
  });

  test("splits on underscores and hyphens", () => {
    expect(labelForCredentialKey("warehouse-password")).toBe("Warehouse Password");
  });

  test("an opaque segment stays opaque rather than becoming invented prose", () => {
    expect(labelForCredentialKey("acme.xyzzy")).toBe("Xyzzy");
  });
});

describe("secretHeaderFields", () => {
  test("derives one field per declared header, in declaration order", () => {
    const fields = secretHeaderFields(
      install({
        "X-Db-Url": { ref: "credential", key: "acme.db_url" },
        "X-Api-Key": { ref: "credential", key: "acme.api_key" },
      }),
    );
    expect(fields).toEqual([
      { header: "X-Db-Url", key: "acme.db_url", label: "Database URL" },
      { header: "X-Api-Key", key: "acme.api_key", label: "API Key" },
    ]);
  });

  test("the entry's own label and help win over the derivation", () => {
    const fields = secretHeaderFields(
      install({
        "X-Db-Url": {
          ref: "credential",
          key: "acme.db_url",
          label: "Warehouse connection string",
          help: "Found under Settings → Connections.",
        },
      }),
    );
    expect(fields[0]?.label).toBe("Warehouse connection string");
    expect(fields[0]?.help).toBe("Found under Settings → Connections.");
  });

  // A catalog entry carrying a literal is miscurated and the server refuses to
  // install it, naming the header. There is no value to ask a user for — the
  // key it would be written against does not exist.
  test("a literal where a reference belongs yields no field to prompt for", () => {
    expect(secretHeaderFields(install({ "X-Db-Url": "postgres://literal.test/db" }))).toEqual([]);
  });

  // Only the `provider` branch of the install wires a header. A dcr/static/
  // composio entry declaring the field is ignored at install, so asking for its
  // value would store a secret nothing sends.
  test("a non-provider entry declaring the field prompts for nothing", () => {
    const declared = { "X-Db-Url": { ref: "credential", key: "acme.db_url" } };
    expect(secretHeaderFields(install(declared, "dcr"))).toEqual([]);
    expect(secretHeaderFields(install(declared, "static"))).toEqual([]);
    expect(secretHeaderFields(install(declared, "composio"))).toEqual([]);
    expect(secretHeaderFields(install(declared))).toHaveLength(1);
  });

  test("an entry that declares nothing prompts for nothing", () => {
    expect(secretHeaderFields(install())).toEqual([]);
    expect(secretHeaderFields({ kind: "direct-url", url: "https://x.test" })).toEqual([]);
  });
});
