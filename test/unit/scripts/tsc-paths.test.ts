import { describe, expect, test } from "bun:test";
import { normalizeTscPath, tscBinary, unlistedSources } from "../../../scripts/lib/tsc-paths.ts";

describe("TypeScript verification paths", () => {
  test("uses each package's installed tsc.exe on Windows", () => {
    const binary = tscBinary("web", "win32");
    expect(normalizeTscPath(binary)).toBe("web/node_modules/.bin/tsc.exe");
  });

  test("uses the extensionless executable on other platforms", () => {
    const binary = tscBinary("web", "linux");
    expect(normalizeTscPath(binary)).toBe("web/node_modules/.bin/tsc");
  });

  test("reconciles Windows filesystem paths with tsc output and still detects omissions", () => {
    const sources = ["C:\\Repo\\web\\src\\App.tsx", "C:\\Repo\\test\\unit\\missing.test.ts"];
    const listed = ["c:/repo/web/src/App.tsx\r", "C:/repo/node_modules/typescript/lib.d.ts"];
    expect(unlistedSources(sources, listed, "win32")).toEqual([sources[1]]);
    expect(normalizeTscPath("C:\\Repo\\WEB\\src\\App.tsx\r", "win32")).toBe(
      "c:/repo/web/src/app.tsx",
    );
  });

  test("keeps case-sensitive paths distinct on Linux", () => {
    expect(unlistedSources(["/repo/src/App.tsx"], ["/repo/src/app.tsx"], "linux")).toEqual([
      "/repo/src/App.tsx",
    ]);
  });
});
