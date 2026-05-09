import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StaticRegistry,
  readStaticServers,
  validateStaticServers,
} from "../../src/connectors/static-registry.ts";
import type { RegistryConfig } from "../../src/registries/types.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-static-reg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const VALID_REMOTE = {
  name: "io.example/test",
  title: "Example",
  description: "An example entry",
  version: "1.0.0",
  icons: [{ src: "https://example.com/icon.svg", sizes: ["any"] }],
  remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
  _meta: {
    "ai.nimblebrain/connector": {
      defaultScope: "workspace",
      auth: "dcr",
      tags: ["test"],
    },
  },
};

const VALID_BUNDLE = {
  name: "dev.mpak.acme/echo",
  title: "Echo",
  description: "Echo bundle",
  version: "1.0.0",
  packages: [{ registryType: "mpak", identifier: "@acme/echo", transport: { type: "stdio" } }],
};

describe("readStaticServers", () => {
  test("loads canonical { servers: [...] } YAML", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "catalog.yaml");
      writeFileSync(path, `servers:\n  - ${JSON.stringify(VALID_REMOTE)}\n`);
      const out = readStaticServers(path);
      expect(out.length).toBe(1);
      expect(out[0]?.name).toBe("io.example/test");
    } finally {
      cleanup();
    }
  });

  test("loads bare-array JSON (legacy NB_CATALOG_PATH contract)", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "catalog.json");
      writeFileSync(path, JSON.stringify([VALID_REMOTE, VALID_BUNDLE]));
      const out = readStaticServers(path);
      expect(out.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("loads canonical { servers: [...] } JSON", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "catalog.json");
      writeFileSync(path, JSON.stringify({ servers: [VALID_REMOTE] }));
      const out = readStaticServers(path);
      expect(out.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("returns [] on missing file (logged warning, no throw)", () => {
    const out = readStaticServers("/nonexistent/path/here.yaml");
    expect(out).toEqual([]);
  });

  test("returns [] on unparseable YAML", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "broken.yaml");
      writeFileSync(path, "this: is: not: valid: yaml: : :\n  - [unclosed");
      const out = readStaticServers(path);
      expect(out).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("validateStaticServers", () => {
  test("drops invalid entries with logged warning, keeps the valid subset", () => {
    const out = validateStaticServers(
      [VALID_REMOTE, { name: "no-slash", description: "x", version: "1" }, VALID_BUNDLE],
      "<test>",
    );
    // Only entries that pass upstream ajv survive — `no-slash` violates
    // the reverse-DNS pattern.
    expect(out.length).toBe(2);
  });

  test("drops duplicates by name (first wins)", () => {
    const dup = { ...VALID_REMOTE, title: "Duplicate" };
    const out = validateStaticServers([VALID_REMOTE, dup], "<test>");
    expect(out.length).toBe(1);
    expect(out[0]?.title).toBe("Example");
  });

  test("returns [] on top-level shape that's neither array nor {servers}", () => {
    expect(validateStaticServers({ wrong: "shape" }, "<test>")).toEqual([]);
    expect(validateStaticServers(42 as unknown, "<test>")).toEqual([]);
    expect(validateStaticServers(null as unknown, "<test>")).toEqual([]);
  });
});

describe("StaticRegistry.listEntries", () => {
  function cfg(over: Partial<RegistryConfig> = {}): RegistryConfig {
    return {
      id: "test-static",
      name: "Test",
      type: "static",
      enabled: true,
      ...over,
    };
  }

  test("projects ServerDetail to DirectoryEntry with registryId/type attribution", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "catalog.yaml");
      writeFileSync(path, `servers:\n  - ${JSON.stringify(VALID_REMOTE)}\n`);
      const reg = new StaticRegistry(cfg(), path);
      const entries = await reg.listEntries();
      expect(entries.length).toBe(1);
      const e = entries[0];
      expect(e?.id).toBe("io.example/test");
      expect(e?.name).toBe("Example");
      expect(e?.registryId).toBe("test-static");
      expect(e?.registryType).toBe("static");
      expect(e?.install.kind).toBe("remote-oauth");
      expect(e?.tags).toEqual(["test"]);
    } finally {
      cleanup();
    }
  });

  test("calls isOperatorConfigured for static-auth entries only", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const staticAuthEntry = {
        ...VALID_REMOTE,
        name: "io.staticauth/mcp",
        _meta: {
          "ai.nimblebrain/connector": {
            defaultScope: "workspace",
            auth: "static",
            operatorSetup: {
              portalUrl: "https://example.com/portal",
              hint: "Create an app",
              clientSecretKey: "x.client_secret",
            },
          },
        },
      };
      const path = join(dir, "catalog.yaml");
      writeFileSync(
        path,
        `servers:\n  - ${JSON.stringify(VALID_REMOTE)}\n  - ${JSON.stringify(staticAuthEntry)}\n`,
      );
      const reg = new StaticRegistry(cfg(), path);
      const calls: Array<[string, string]> = [];
      const entries = await reg.listEntries({
        wsId: "ws_x",
        isOperatorConfigured: async (id, key) => {
          calls.push([id, key]);
          return true;
        },
      });
      // Only the static-auth entry should have triggered the resolver
      // and been stamped with operatorConfigured: true. The DCR entry
      // leaves the field undefined (no meaningful value to render).
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(["io.staticauth/mcp", "x.client_secret"]);
      const dcr = entries.find((e) => e.id === VALID_REMOTE.name);
      const sa = entries.find((e) => e.id === "io.staticauth/mcp");
      expect(dcr?.operatorConfigured).toBeUndefined();
      expect(sa?.operatorConfigured).toBe(true);
    } finally {
      cleanup();
    }
  });
});
