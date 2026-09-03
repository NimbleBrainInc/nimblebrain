import { describe, expect, it } from "bun:test";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { BundleLifecycleManager } from "../../../src/bundles/lifecycle.ts";
import { PlacementRegistry } from "../../../src/runtime/placement-registry.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import type { BundleRef, PlacementDeclaration } from "../../../src/bundles/types.ts";

/**
 * Placements ride on the connector's `BundleRef.ui`, copied there at install
 * time from the operator-trusted catalog entry. `seedInstance` records the
 * instance and `notifyInstalled` registers what it declares; `uninstall`
 * unregisters. This pins that round trip — no live source is needed, because
 * placement registration reads the ref, not the wire.
 */

const WS = "ws_test";
const URL = "https://echo.example.com/mcp";
const SERVER = "echo";

function makeEventCollector(): EventSink & { events: EngineEvent[] } {
	const events: EngineEvent[] = [];
	return { events, emit: (event: EngineEvent) => void events.push(event) };
}

function refWithUi(placements?: PlacementDeclaration[]): BundleRef {
	return {
		url: URL,
		serverName: SERVER,
		ui: { name: "Echo App", icon: "echo-icon", ...(placements ? { placements } : {}) },
	};
}

function seedAndNotify(
	lifecycle: BundleLifecycleManager,
	ref: BundleRef,
): void {
	lifecycle.seedInstance(SERVER, URL, ref, undefined, WS);
	lifecycle.notifyInstalled(SERVER, WS);
}

describe("BundleLifecycleManager — placement registration on install", () => {
	it("a connector declaring placements registers them in PlacementRegistry", () => {
		const placements: PlacementDeclaration[] = [
			{ slot: "sidebar.apps", resourceUri: "ui://echo/nav", priority: 30, label: "Echo" },
			{ slot: "main", resourceUri: "ui://echo/board", route: "echo", label: "Echo Board" },
		];
		const sink = makeEventCollector();
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(sink, undefined);
		lifecycle.setPlacementRegistry(pr);

		seedAndNotify(lifecycle, refWithUi(placements));

		const instance = lifecycle.getInstance(SERVER, WS)!;
		expect(instance.ui?.placements).toHaveLength(2);

		const wsPlacements = pr.forWorkspace(WS);
		const sidebarApps = wsPlacements.filter((e) => e.slot === "sidebar.apps");
		expect(sidebarApps).toHaveLength(1);
		expect(sidebarApps[0].resourceUri).toBe("ui://echo/nav");
		expect(sidebarApps[0].serverName).toBe(SERVER);

		const main = wsPlacements.filter((e) => e.slot === "main");
		expect(main).toHaveLength(1);
		expect(main[0].route).toBe("echo");

		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect(installEvent!.data.placements).toHaveLength(2);
	});

	it("a connector with UI but no placements registers none", () => {
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);
		lifecycle.setPlacementRegistry(pr);

		seedAndNotify(lifecycle, refWithUi());

		expect(lifecycle.getInstance(SERVER, WS)!.ui?.placements).toBeUndefined();
		expect(pr.forWorkspace(WS)).toHaveLength(0);
	});

	it("a spoofed placement is dropped, and the valid siblings survive", () => {
		// Placements persist RAW on the ref, so `registerPlacements` sanitizes at
		// registration. Fail-closed per-placement: one bad entry does not take
		// the rest of the declaration with it.
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);
		lifecycle.setPlacementRegistry(pr);

		seedAndNotify(
			lifecycle,
			refWithUi([
				{ slot: "sidebar.apps", resourceUri: "ui://echo/nav", priority: 30 },
				{ slot: "main", resourceUri: "https://evil.test/page" } as PlacementDeclaration,
			]),
		);

		const wsPlacements = pr.forWorkspace(WS);
		expect(wsPlacements).toHaveLength(1);
		expect(wsPlacements[0].resourceUri).toBe("ui://echo/nav");
	});
});

describe("BundleLifecycleManager — placement unregistration on uninstall", () => {
	it("uninstall removes placements from PlacementRegistry", async () => {
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);
		lifecycle.setPlacementRegistry(pr);

		seedAndNotify(
			lifecycle,
			refWithUi([{ slot: "sidebar.apps", resourceUri: "ui://echo/nav", priority: 30 }]),
		);
		expect(pr.forWorkspace(WS).filter((e) => e.slot === "sidebar.apps")).toHaveLength(1);

		await lifecycle.uninstall(SERVER, new ToolRegistry(), WS);

		expect(pr.forWorkspace(WS)).toHaveLength(0);
	});
});

describe("nb-core placements via PlacementRegistry", () => {
	it("registers ambient core placements across multiple slots", () => {
		// Representative payload — the registry doesn't care about the
		// specific URIs, only that ambient (no wsId) entries surface for
		// any workspace and stay tagged with their serverName. The actual
		// per-source placements in production are declared by each
		// platform source's factory and registered via `Runtime.start()`.
		const pr = new PlacementRegistry();

		const NB_CORE_PLACEMENTS: PlacementDeclaration[] = [
			{ slot: "main", resourceUri: "ui://core/usage-dashboard", route: "usage", label: "Usage", icon: "📊" },
			{ slot: "sidebar", resourceUri: "ui://core/home-nav", route: "home", label: "Home", icon: "🏠" },
		];
		pr.register("nb", NB_CORE_PLACEMENTS);

		const all = pr.forWorkspace("ws_any");
		expect(all).toHaveLength(2);
		for (const entry of all) expect(entry.serverName).toBe("nb");
		expect(all.filter((e) => e.slot === "main")).toHaveLength(1);
		expect(all.filter((e) => e.slot === "sidebar")).toHaveLength(1);
	});

	it("connector placements coexist with nb-core placements", () => {
		const pr = new PlacementRegistry();

		pr.register("nb", [{ slot: "sidebar.apps", resourceUri: "ui://core/app-nav", priority: 20 }]);
		pr.register(
			"tasks",
			[
				{ slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 30 },
				{ slot: "main", resourceUri: "ui://tasks/board", route: "tasks" },
			],
			WS,
		);

		const wsEntries = pr.forWorkspace(WS);
		const sidebarApps = wsEntries.filter((e) => e.slot === "sidebar.apps");
		expect(sidebarApps).toHaveLength(2);
		expect(sidebarApps[0].serverName).toBe("nb"); // priority 20
		expect(sidebarApps[1].serverName).toBe("tasks"); // priority 30

		expect(wsEntries).toHaveLength(3);
	});
});
