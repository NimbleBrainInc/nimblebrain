import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDevInstanceConfig } from "../../../scripts/lib/dev-instance.ts";
import { loadInstanceConfig } from "../../../src/identity/instance.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nb-dev-instance-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureDevInstanceConfig", () => {
  test("writes the dev adapter into a workdir that has no instance.json", async () => {
    const workDir = join(root, "work");
    expect(ensureDevInstanceConfig(workDir)).toBe(join(workDir, "instance.json"));
    expect(await loadInstanceConfig(workDir)).toEqual({ auth: { adapter: "dev" } });
  });

  test("leaves an existing instance.json alone", () => {
    const existing = JSON.stringify({ auth: { adapter: "oidc", issuer: "https://idp.example.com" } });
    writeFileSync(join(root, "instance.json"), existing);
    expect(ensureDevInstanceConfig(root)).toBeNull();
    expect(readFileSync(join(root, "instance.json"), "utf-8")).toBe(existing);
  });
});
