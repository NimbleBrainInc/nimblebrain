import { describe, expect, it } from "bun:test";
import {
  CONNECTION_AUDIENCE,
  CONNECTION_CREDENTIAL_TTL_MS,
  createRunKey,
  MODEL_CREDENTIAL_LEEWAY_MS,
  MODEL_GATEWAY_AUDIENCE,
  parseRunKeyRing,
  RunKeyError,
} from "../../../src/runtime/run-key.ts";
import { runKeyJwk, runKeyRingValue, verifyAsGateway } from "../../helpers/run-key.ts";

const ISSUER = "https://runtime.example.test";
const MAX_RUN_MS = 600_000;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const GATEWAY = { issuer: ISSUER, audience: MODEL_GATEWAY_AUDIENCE };

function runKeyOver(...keys: ReturnType<typeof runKeyJwk>[]) {
  return createRunKey({
    ring: parseRunKeyRing(runKeyRingValue(...keys)),
    issuer: ISSUER,
    maxRunMs: MAX_RUN_MS,
  });
}

describe("model credential", () => {
  const runKey = runKeyOver(runKeyJwk("run-2026-01"));
  const token = runKey.mintModelCredential({ runId: "run_abc", workspaceId: "ws_acme" }, NOW);

  it("verifies against the published key set", async () => {
    const { header, claims } = await verifyAsGateway(token, runKey.keySet(), {
      ...GATEWAY,
      nowMs: NOW,
    });
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "run-2026-01" });
    expect(claims).toEqual({
      iss: ISSUER,
      aud: MODEL_GATEWAY_AUDIENCE,
      sub: "run_abc",
      workspace: "ws_acme",
      iat: NOW / 1000,
      exp: (NOW + MAX_RUN_MS + MODEL_CREDENTIAL_LEEWAY_MS) / 1000,
    });
  });

  it("names the run and nothing that bounds it", async () => {
    const { claims } = await verifyAsGateway(token, runKey.keySet(), { ...GATEWAY, nowMs: NOW });
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sub", "workspace"]);
  });

  it("still verifies at the longest run, and not at the end of the leeway", async () => {
    const expiry = NOW + MAX_RUN_MS + MODEL_CREDENTIAL_LEEWAY_MS;
    await verifyAsGateway(token, runKey.keySet(), { ...GATEWAY, nowMs: expiry - 1_000 });
    await expect(
      verifyAsGateway(token, runKey.keySet(), { ...GATEWAY, nowMs: expiry }),
    ).rejects.toThrow("expired");
  });

  it("is refused by a verifier expecting another audience", async () => {
    await expect(
      verifyAsGateway(token, runKey.keySet(), {
        issuer: ISSUER,
        audience: "tool-projection",
        nowMs: NOW,
      }),
    ).rejects.toThrow("audience");
  });

  it("is refused when a byte of its claims changes", async () => {
    const [h, p, s] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const widened = Buffer.from(JSON.stringify({ ...claims, sub: "run_other" })).toString(
      "base64url",
    );
    await expect(
      verifyAsGateway(`${h}.${widened}.${s}`, runKey.keySet(), { ...GATEWAY, nowMs: NOW }),
    ).rejects.toThrow("signature");
  });

  it("lasts the run's own limit when it has one", async () => {
    const limited = runKey.mintModelCredential(
      { runId: "run_abc", workspaceId: "ws_acme", maxRunDurationMs: 30_000 },
      NOW,
    );
    const { claims } = await verifyAsGateway(limited, runKey.keySet(), { ...GATEWAY, nowMs: NOW });
    expect(claims.exp).toBe((NOW + 30_000 + MODEL_CREDENTIAL_LEEWAY_MS) / 1000);
  });

  it("is held to the longest run the installation allows", async () => {
    const long = runKey.mintModelCredential(
      { runId: "run_abc", workspaceId: "ws_acme", maxRunDurationMs: MAX_RUN_MS * 3 },
      NOW,
    );
    const { claims } = await verifyAsGateway(long, runKey.keySet(), { ...GATEWAY, nowMs: NOW });
    expect(claims.exp).toBe((NOW + MAX_RUN_MS + MODEL_CREDENTIAL_LEEWAY_MS) / 1000);
  });

  it("refuses a run limit that is not a positive duration", () => {
    for (const maxRunDurationMs of [0, -1, Number.NaN]) {
      expect(() =>
        runKey.mintModelCredential({ runId: "run_abc", workspaceId: "ws_acme", maxRunDurationMs }),
      ).toThrow(RunKeyError);
    }
  });

  it("refuses to mint without a run or a workspace", () => {
    expect(() => runKey.mintModelCredential({ runId: "", workspaceId: "ws_acme" })).toThrow(
      RunKeyError,
    );
    expect(() => runKey.mintModelCredential({ runId: "run_abc", workspaceId: "" })).toThrow(
      RunKeyError,
    );
  });
});

describe("pool credential", () => {
  it("names the pool, for the gateway, for the lifetime the caller gives", async () => {
    const runKey = runKeyOver(runKeyJwk("run-2026-01"));
    const token = runKey.mintPoolCredential({ poolId: "pool-main", ttlMs: 3_600_000 }, NOW);
    const { claims } = await verifyAsGateway(token, runKey.keySet(), { ...GATEWAY, nowMs: NOW });
    expect(claims).toEqual({
      iss: ISSUER,
      aud: MODEL_GATEWAY_AUDIENCE,
      sub: "pool-main",
      iat: NOW / 1000,
      exp: (NOW + 3_600_000) / 1000,
    });
  });
});

describe("connection credential", () => {
  it("names the installation and no run, for the worker's audience alone", async () => {
    const runKey = runKeyOver(runKeyJwk("run-2026-01"));
    const token = runKey.mintConnectionCredential(NOW);
    const { claims } = await verifyAsGateway(token, runKey.keySet(), {
      issuer: ISSUER,
      audience: CONNECTION_AUDIENCE,
      nowMs: NOW,
    });
    expect(claims).toEqual({
      iss: ISSUER,
      aud: CONNECTION_AUDIENCE,
      sub: "runtime",
      iat: NOW / 1000,
      exp: (NOW + CONNECTION_CREDENTIAL_TTL_MS) / 1000,
    });
    // A gateway refuses it: it opens a worker connection and spends nothing.
    await expect(
      verifyAsGateway(token, runKey.keySet(), { ...GATEWAY, nowMs: NOW }),
    ).rejects.toThrow();
  });
});

describe("rotation", () => {
  const outgoing = runKeyJwk("run-old");
  const incoming = runKeyJwk("run-new");

  it("signs with the first key and publishes every key", () => {
    const runKey = runKeyOver(incoming, outgoing);
    expect(runKey.keySet().keys.map((k) => k.kid)).toEqual(["run-new", "run-old"]);
    const token = runKey.mintModelCredential({ runId: "r", workspaceId: "w" }, NOW);
    const header = JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString());
    expect(header.kid).toBe("run-new");
  });

  it("a credential the outgoing key signed verifies against the rotated set", async () => {
    const before = runKeyOver(outgoing);
    const issued = before.mintModelCredential({ runId: "r", workspaceId: "w" }, NOW);
    const after = runKeyOver(incoming, outgoing);
    await verifyAsGateway(issued, after.keySet(), { ...GATEWAY, nowMs: NOW });
  });

  it("and stops verifying once the outgoing key leaves the ring", async () => {
    const issued = runKeyOver(outgoing).mintModelCredential({ runId: "r", workspaceId: "w" }, NOW);
    await expect(
      verifyAsGateway(issued, runKeyOver(incoming).keySet(), { ...GATEWAY, nowMs: NOW }),
    ).rejects.toThrow("unknown kid");
  });
});

describe("the published key set", () => {
  it("carries the public halves only", () => {
    const key = runKeyJwk("run-2026-01");
    const published = runKeyOver(key).keySet();
    expect(published).toEqual({
      keys: [
        { kty: "OKP", crv: "Ed25519", x: key.x, kid: "run-2026-01", alg: "EdDSA", use: "sig" },
      ],
    });
    expect(JSON.stringify(published)).not.toContain(key.d);
  });
});

describe("parseRunKeyRing refuses", () => {
  const key = runKeyJwk("k1");
  const cases: [string, string, RegExp][] = [
    ["a value that is not JSON", "not json", /not JSON/],
    ["a bare key rather than a set", JSON.stringify(key), /JWK Set/],
    ["an empty set", runKeyRingValue(), /names no key/],
    [
      "more than three keys",
      runKeyRingValue(runKeyJwk("a"), runKeyJwk("b"), runKeyJwk("c"), runKeyJwk("d")),
      /at most 3/,
    ],
    ["a kid named twice", runKeyRingValue(runKeyJwk("dup"), runKeyJwk("dup")), /twice/],
    ["a key with no kid", JSON.stringify({ keys: [{ ...key, kid: "" }] }), /no "kid"/],
    ["a key of another curve", JSON.stringify({ keys: [{ ...key, crv: "X25519" }] }), /Ed25519/],
    ["a key with no private half", JSON.stringify({ keys: [{ ...key, d: undefined }] }), /"d"/],
    [
      "a private half that is not a key",
      JSON.stringify({ keys: [{ ...key, d: "AAAA" }] }),
      /not a valid Ed25519/,
    ],
    [
      "a public half from another key",
      JSON.stringify({ keys: [{ ...key, x: runKeyJwk("other").x }] }),
      /two keys/,
    ],
  ];

  for (const [name, value, message] of cases) {
    it(name, () => {
      expect(() => parseRunKeyRing(value)).toThrow(message);
    });
  }

  it("without quoting key material in the error", () => {
    let caught: unknown;
    try {
      parseRunKeyRing(JSON.stringify({ keys: [{ ...key, x: runKeyJwk("other").x }] }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunKeyError);
    expect(String(caught)).not.toContain(key.d);
  });
});
