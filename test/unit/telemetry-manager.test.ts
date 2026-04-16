import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import type { TelemetryClient, TelemetryClientFactory } from "../../src/telemetry/manager.ts";

class MockTelemetryClient implements TelemetryClient {
	events: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = [];
	shutdownCalled = false;
	capture(params: { distinctId: string; event: string; properties: Record<string, unknown> }) {
		this.events.push(params);
	}
	async shutdown() {
		this.shutdownCalled = true;
	}
}

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "telemetry-test-"));
}

function mockFactory(mock: MockTelemetryClient): TelemetryClientFactory {
	return (_apiKey, _options) => mock;
}

describe("TelemetryManager", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedEnv["NB_TELEMETRY_DISABLED"] = process.env["NB_TELEMETRY_DISABLED"];
		savedEnv["DO_NOT_TRACK"] = process.env["DO_NOT_TRACK"];
		delete process.env["NB_TELEMETRY_DISABLED"];
		delete process.env["DO_NOT_TRACK"];
	});

	afterEach(() => {
		// Restore env vars
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
	});

	it("disabled when NB_TELEMETRY_DISABLED=1", () => {
		process.env["NB_TELEMETRY_DISABLED"] = "1";
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		expect(mgr.isEnabled()).toBe(false);

		// capture should be a no-op
		mgr.capture("test.event", { foo: 1 });
		expect(mock.events).toHaveLength(0);
	});

	it("disabled when DO_NOT_TRACK=1", () => {
		process.env["DO_NOT_TRACK"] = "1";
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		expect(mgr.isEnabled()).toBe(false);

		mgr.capture("test.event", { foo: 1 });
		expect(mock.events).toHaveLength(0);
	});

	it("disabled when config enabled=false", () => {
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			enabled: false,
			clientFactory: mockFactory(mock),
		});

		expect(mgr.isEnabled()).toBe(false);
	});

	it("enabled by default", () => {
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		expect(mgr.isEnabled()).toBe(true);
	});

	it("creates .telemetry-id on first run", () => {
		const dir = makeTmpDir();
		const mock = new MockTelemetryClient();
		TelemetryManager.create({
			workDir: dir,
			clientFactory: mockFactory(mock),
		});

		const idPath = join(dir, ".telemetry-id");
		expect(existsSync(idPath)).toBe(true);

		const id = readFileSync(idPath, "utf-8").trim();
		// UUID v4 pattern
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("reads existing ID on subsequent creation", () => {
		const dir = makeTmpDir();
		const mock1 = new MockTelemetryClient();
		const mock2 = new MockTelemetryClient();

		const mgr1 = TelemetryManager.create({
			workDir: dir,
			clientFactory: mockFactory(mock1),
		});
		const mgr2 = TelemetryManager.create({
			workDir: dir,
			clientFactory: mockFactory(mock2),
		});

		expect(mgr1.getAnonymousId()).toBe(mgr2.getAnonymousId());
	});

	it("resetId generates new UUID", () => {
		const dir = makeTmpDir();
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: dir,
			clientFactory: mockFactory(mock),
		});

		const originalId = mgr.getAnonymousId();
		const newId = TelemetryManager.resetId(dir);

		expect(newId).not.toBe(originalId);
		expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("capture enriches with common properties", () => {
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		mgr.capture("test.event", { custom: "value" });

		expect(mock.events).toHaveLength(1);
		const props = mock.events[0].properties;
		expect(props.nb_version).toBeDefined();
		expect(props.os).toBe(process.platform);
		expect(props.arch).toBe(process.arch);
		expect(props.custom).toBe("value");
	});

	it("capture is no-op when disabled", () => {
		process.env["NB_TELEMETRY_DISABLED"] = "1";
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		mgr.capture("test.event", { foo: 1 });
		expect(mock.events).toHaveLength(0);
	});

	it("shutdown calls client shutdown", async () => {
		const mock = new MockTelemetryClient();
		const mgr = TelemetryManager.create({
			workDir: makeTmpDir(),
			clientFactory: mockFactory(mock),
		});

		await mgr.shutdown();
		expect(mock.shutdownCalled).toBe(true);
	});
});
