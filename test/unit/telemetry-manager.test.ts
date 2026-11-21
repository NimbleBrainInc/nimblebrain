import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryClient, TelemetryClientFactory } from "../../src/telemetry/manager.ts";
import { TelemetryLockedError, TelemetryManager } from "../../src/telemetry/manager.ts";

type CapturedEvent = Parameters<TelemetryClient["capture"]>[0];

class MockTelemetryClient implements TelemetryClient {
  events: CapturedEvent[] = [];
  shutdownCalled = false;
  capture(params: CapturedEvent) {
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
    savedEnv.NB_TELEMETRY_DISABLED = process.env.NB_TELEMETRY_DISABLED;
    savedEnv.DO_NOT_TRACK = process.env.DO_NOT_TRACK;
    delete process.env.NB_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
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
    process.env.NB_TELEMETRY_DISABLED = "1";
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
    process.env.DO_NOT_TRACK = "1";
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

  it("sends nothing until a person answers", () => {
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      clientFactory: mockFactory(mock),
    });

    expect(mgr.status()).toEqual({ consent: "undecided" });
    expect(mgr.isEnabled()).toBe(false);
    mgr.capture("test.event");
    expect(mock.events).toHaveLength(0);
  });

  it("a yes takes effect at once and is kept for the next start", () => {
    const dir = makeTmpDir();
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({ workDir: dir, clientFactory: mockFactory(mock) });
    mgr.setConsent("on");
    mgr.capture("test.event");
    expect(mock.events).toHaveLength(1);

    const again = TelemetryManager.create({ workDir: dir, clientFactory: mockFactory(mock) });
    expect(again.status()).toEqual({ consent: "on" });
  });

  it("a no stops sending and is kept", () => {
    const dir = makeTmpDir();
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({ workDir: dir, clientFactory: mockFactory(mock) });
    mgr.setConsent("on");
    mgr.setConsent("off");
    mgr.capture("test.event");
    expect(mock.events).toHaveLength(0);
    expect(
      TelemetryManager.create({ workDir: dir, clientFactory: mockFactory(mock) }).status(),
    ).toEqual({ consent: "off" });
  });

  it("an installer's answer seeds the first start; a recorded answer wins over it", () => {
    const dir = makeTmpDir();
    const mock = new MockTelemetryClient();
    const seeded = TelemetryManager.create({
      workDir: dir,
      clientFactory: mockFactory(mock),
      env: { NB_TELEMETRY_CONSENT: "on" },
    });
    expect(seeded.status()).toEqual({ consent: "on" });
    seeded.setConsent("off");
    const later = TelemetryManager.create({
      workDir: dir,
      clientFactory: mockFactory(mock),
      env: { NB_TELEMETRY_CONSENT: "on" },
    });
    expect(later.status()).toEqual({ consent: "off" });
  });

  it("the deployment's decision cannot be changed by a person", () => {
    const mock = new MockTelemetryClient();
    const off = TelemetryManager.create({
      workDir: makeTmpDir(),
      enabled: false,
      clientFactory: mockFactory(mock),
    });
    expect(off.status()).toEqual({ consent: "off", locked: "operator" });
    expect(() => off.setConsent("on")).toThrow(TelemetryLockedError);

    const on = TelemetryManager.create({
      workDir: makeTmpDir(),
      enabled: true,
      clientFactory: mockFactory(mock),
    });
    expect(on.status()).toEqual({ consent: "on", locked: "operator" });
  });

  it("with no key there is nothing to agree to", () => {
    const mgr = TelemetryManager.create({ workDir: makeTmpDir(), env: {} });
    expect(mgr.status()).toEqual({ consent: "off", locked: "no_destination" });
    expect(() => mgr.setConsent("on")).toThrow(TelemetryLockedError);
  });

  it("uses an installer's NB_TELEMETRY_ID so the install reports as one", () => {
    const id = "6f1c2c0e-2a4b-4d7e-9a35-0b8f3f1d2c11";
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      clientFactory: mockFactory(new MockTelemetryClient()),
      env: { NB_TELEMETRY_ID: id },
    });
    expect(mgr.getAnonymousId()).toBe(id);
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
    mgr.setConsent("on");

    mgr.capture("test.event", { custom: "value" });

    expect(mock.events).toHaveLength(1);
    const props = mock.events[0].properties;
    expect(props.nb_version).not.toBe("0.1.0");
    expect(props.nb_version).toBeDefined();
    expect(props.os).toBe(process.platform);
    expect(props.arch).toBe(process.arch);
    expect(props.custom).toBe("value");
  });

  it("capture is no-op when disabled", () => {
    process.env.NB_TELEMETRY_DISABLED = "1";
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
    mgr.setConsent("on");

    await mgr.shutdown();
    expect(mock.shutdownCalled).toBe(true);
  });
});

describe("TelemetryManager identified events", () => {
  const person = { userId: "usr_1", email: "a@example.com", name: "Ada", workspaceId: "ws_1" };

  it("stay anonymous when a person, not the operator, turned telemetry on", () => {
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      identify: true,
      clientFactory: mockFactory(mock),
      env: { NB_TELEMETRY_CONSENT: "on", NB_TENANT_ID: "tenant-a" },
    });
    mgr.setSubjectSource(() => person);

    mgr.capture("test.event");

    expect(mgr.isIdentified()).toBe(false);
    expect(mgr.getTenantId()).toBeUndefined();
    const [event] = mock.events;
    expect(event?.distinctId).toBe(mgr.getAnonymousId());
    expect(event?.groups).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("a@example.com");
  });

  it("name the person, group by tenant and workspace, and set email and name once", () => {
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      enabled: true,
      identify: true,
      clientFactory: mockFactory(mock),
      env: { NB_TENANT_ID: "tenant-a" },
    });
    mgr.setSubjectSource(() => person);

    mgr.capture("first");
    mgr.capture("second");

    const [first, second] = mock.events;
    expect(first?.distinctId).toBe("usr_1");
    expect(first?.groups).toEqual({ tenant: "tenant-a", workspace: "ws_1" });
    expect(first?.properties.$set).toEqual({ email: "a@example.com", name: "Ada" });
    expect(second?.distinctId).toBe("usr_1");
    expect(second?.properties.$set).toBeUndefined();
    expect(mgr.getTenantId()).toBe("tenant-a");
  });

  it("keep work no person asked for on the install, in its tenant", () => {
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      enabled: true,
      identify: true,
      clientFactory: mockFactory(mock),
      env: { NB_TENANT_ID: "tenant-a" },
    });
    mgr.setSubjectSource(() => undefined);

    mgr.capture("background");

    const [event] = mock.events;
    expect(event?.distinctId).toBe(mgr.getAnonymousId());
    expect(event?.groups).toEqual({ tenant: "tenant-a" });
    expect(event?.properties.$set).toBeUndefined();
  });
});
