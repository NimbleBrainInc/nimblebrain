/**
 * The runtime owns the sources every workspace registry shares (the platform
 * apps and the `nb` system source), so `Runtime.shutdown()` stops each of them
 * exactly once, however many workspace registries hold it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ToolSource } from "../../../src/tools/types.ts";
import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../../helpers/two-workspace-fixture.ts";

describe("Runtime.shutdown — shared sources", () => {
  let fixture: TwoWorkspaceFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  it("stops each platform app and the system source once across workspace registries", async () => {
    fixture = await createTwoWorkspaceFixture();
    const runtime = fixture.runtime;
    // biome-ignore lint/plugin/double-cast: `_platformSources` is private; the test counts each one's stops.
    const platform = (runtime as unknown as { _platformSources: ToolSource[] })._platformSources;
    const system = runtime._systemSource;
    expect(platform.length).toBeGreaterThan(0);
    expect(system).not.toBeNull();

    const shared = [...platform, system as ToolSource];
    const stops = new Map<string, number>();
    for (const source of shared) {
      const stop = source.stop.bind(source);
      source.stop = async () => {
        stops.set(source.name, (stops.get(source.name) ?? 0) + 1);
        await stop();
      };
    }

    // Both workspaces hold a registry, and every shared source but the
    // identity apps sits in both, so a registry-side stop would count twice.
    expect(fixture.shared.id).not.toBe(fixture.personal.id);
    const registries = [
      await runtime.ensureWorkspaceRegistry(fixture.shared.id),
      await runtime.ensureWorkspaceRegistry(fixture.personal.id),
    ];
    const inBoth = shared.filter((s) => registries.every((r) => r.hasSource(s.name)));
    expect(inBoth.map((s) => s.name)).toContain("nb");
    expect(inBoth.length).toBeGreaterThan(1);

    // `cleanup()` is the shutdown under test; it also removes the work dir.
    await fixture.cleanup();
    fixture = null;

    for (const source of shared) {
      expect({ name: source.name, stops: stops.get(source.name) ?? 0 }).toEqual({
        name: source.name,
        stops: 1,
      });
    }
  });
});
