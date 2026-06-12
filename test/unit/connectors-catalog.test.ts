import { describe, expect, test } from "bun:test";
import {
  getNimbleBrainConnectorMeta,
  validateServerDetail,
} from "../../src/connectors/server-detail.ts";
import { readStaticServers } from "../../src/registries/static-source.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";

// The catalog *contract* — the shape rules every curated catalog file
// must satisfy. Validated against a representative fixture directory
// (one DCR, one static-auth, one Composio entry) rather than the
// shipped catalog: production curation lives in deployments, so coupling
// this suite to it would break the contract test on every curation edit.
describe("curated catalog contract", () => {
  test("parses + validates as ServerDetail with zero drops", () => {
    const servers = readStaticServers(CONNECTOR_FIXTURE_DIR);
    expect(servers.length).toBeGreaterThan(0);
    for (const s of servers) {
      const result = validateServerDetail(s);
      expect(result.valid).toBe(true);
    }
  });

  test("all reverse-DNS names are unique", () => {
    const servers = readStaticServers(CONNECTOR_FIXTURE_DIR);
    const names = servers.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("static-auth entries all have operatorSetup with clientSecretKey", () => {
    const servers = readStaticServers(CONNECTOR_FIXTURE_DIR);
    let staticSeen = 0;
    for (const s of servers) {
      const meta = getNimbleBrainConnectorMeta(s);
      if (meta?.auth === "static") {
        staticSeen++;
        expect(meta.operatorSetup).toBeDefined();
        expect(meta.operatorSetup?.clientSecretKey.length).toBeGreaterThan(0);
        expect(meta.operatorSetup?.portalUrl.startsWith("http")).toBe(true);
      }
    }
    expect(staticSeen).toBeGreaterThan(0); // fixture covers the static-auth shape
  });

  test("composio entries all have a composio block with toolkit + authConfigEnv", () => {
    // validateServerDetail only checks the upstream ServerDetail shape, not
    // the NimbleBrain composio block — a missing toolkit or a typo'd
    // authConfigEnv would otherwise pass validation and only surface at
    // install time (handleInstallRemoteOAuth reads process.env[authConfigEnv]).
    // This pins the block's presence and the env-var naming convention the
    // ClusterExternalSecret wires (COMPOSIO_<TOOLKIT>_AUTH_CONFIG_ID).
    let composioSeen = 0;
    for (const s of readStaticServers(CONNECTOR_FIXTURE_DIR)) {
      const meta = getNimbleBrainConnectorMeta(s);
      if (meta?.auth !== "composio") continue;
      composioSeen++;
      expect(meta.composio).toBeDefined();
      expect(meta.composio?.toolkit.length).toBeGreaterThan(0);
      expect(meta.composio?.authConfigEnv).toMatch(/^COMPOSIO_[A-Z0-9_]+_AUTH_CONFIG_ID$/);
      // A `tools` allowlist, when present, must be non-empty — an empty
      // array would mint a Composio session that exposes zero tools.
      if (meta.composio?.tools) {
        expect(meta.composio.tools.length).toBeGreaterThan(0);
      }
    }
    expect(composioSeen).toBeGreaterThan(0); // fixture covers the composio shape
  });

  test("every entry carries an icon (Browse renders <img src>)", () => {
    const servers = readStaticServers(CONNECTOR_FIXTURE_DIR);
    for (const s of servers) {
      const icon = s.icons?.[0];
      expect(icon).toBeDefined();
      expect(icon?.src.startsWith("https://")).toBe(true);
    }
  });
});

describe("validateServerDetail", () => {
  function makeValid(over: Record<string, unknown> = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: "io.example/test",
      title: "Example",
      description: "A test entry",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
    };
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) {
        delete base[k];
      } else {
        base[k] = v;
      }
    }
    return base;
  }

  test("rejects entries missing required fields", () => {
    expect(validateServerDetail(makeValid({ name: undefined })).valid).toBe(false);
    expect(validateServerDetail(makeValid({ description: undefined })).valid).toBe(false);
    expect(validateServerDetail(makeValid({ version: undefined })).valid).toBe(false);
  });

  test("rejects names that don't match upstream reverse-DNS pattern", () => {
    expect(validateServerDetail(makeValid({ name: "no-slash" })).valid).toBe(false);
    expect(validateServerDetail(makeValid({ name: "two/slashes/here" })).valid).toBe(false);
    expect(validateServerDetail(makeValid({ name: "io.asana/mcp" })).valid).toBe(true);
  });

  test("description max length enforced (upstream caps at 100 chars)", () => {
    const longDesc = "a".repeat(101);
    expect(validateServerDetail(makeValid({ description: longDesc })).valid).toBe(false);
    expect(validateServerDetail(makeValid({ description: "a".repeat(100) })).valid).toBe(true);
  });

  test("accepts entries with only packages (stdio bundle)", () => {
    const detail = makeValid({
      remotes: undefined,
      packages: [{ registryType: "mpak", identifier: "@x/y", transport: { type: "stdio" } }],
    });
    expect(validateServerDetail(detail).valid).toBe(true);
  });

  test("accepts _meta with arbitrary reverse-DNS extension keys", () => {
    const detail = makeValid({
      _meta: {
        "ai.nimblebrain/connector": { auth: "dcr" },
        "dev.mpak/registry": { downloads: 42 },
      },
    });
    expect(validateServerDetail(detail).valid).toBe(true);
  });
});
