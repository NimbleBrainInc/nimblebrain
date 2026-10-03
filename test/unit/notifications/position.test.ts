/**
 * The install-time outbox position, against a real MCP server on a real
 * transport.
 *
 * The case this suite exists for: a connector's `on_ready` starts work that
 * finishes in seconds and reports itself through the outbox. If the poller's
 * first read is the bootstrap, it lands after that report and steps over it.
 * Taking the position before the handler runs is what puts the report after
 * the cursor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { clearCursor, readCursor, writeCursor } from "../../../src/notifications/cursors.ts";
import { resolvePollConfig } from "../../../src/notifications/poll-config.ts";
import { NotificationPoller, type PollTarget } from "../../../src/notifications/poller.ts";
import { positionOutbox } from "../../../src/notifications/position.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  FIXTURE_OUTBOX_URI,
  fixtureEvent,
  makeOutboxFixture,
  type OutboxFixture,
} from "../../helpers/outbox-fixture.ts";

let workDir: string;
let workspaceStore: WorkspaceStore;
let wsId: string;
const teardown: Array<() => Promise<void>> = [];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-position-"));
  workspaceStore = new WorkspaceStore(workDir);
  wsId = (await workspaceStore.create("Position")).id;
});

afterEach(async () => {
  for (const stop of teardown.splice(0)) await stop();
  rmSync(workDir, { recursive: true, force: true });
});

function storeFor(id: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId: id, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

async function fixture(): Promise<OutboxFixture> {
  const made = await makeOutboxFixture();
  teardown.push(() => made.stop());
  return made;
}

function targetFor(outbox: OutboxFixture): PollTarget {
  return {
    wsId,
    serverName: outbox.source.name,
    resource: FIXTURE_OUTBOX_URI,
    source: outbox.source,
  };
}

function pollerOver(targets: PollTarget[]): NotificationPoller {
  const poller = new NotificationPoller({
    targets: async () => targets,
    storeFor,
    workspaceStore,
    config: resolvePollConfig({}),
    now: () => 1_800_000_000_000,
  });
  teardown.push(async () => poller.stop());
  return poller;
}

async function storedCursor(connector = "fixture-outbox"): Promise<string | undefined> {
  const ws = await workspaceStore.get(wsId);
  return ws ? readCursor(ws, connector) : undefined;
}

function eventIds(): string[] {
  return storeFor(wsId)
    .list()
    .map((item) => item.envelope.eventId)
    .sort();
}

describe("positionOutbox", () => {
  test("an event the install causes reaches the inbox on the poller's first sweep", async () => {
    const outbox = await fixture();
    outbox.emit(fixtureEvent("evt_history"));

    expect(await positionOutbox(workspaceStore, targetFor(outbox), 50)).toBe(true);
    // What `on_ready` started, reported seconds later — before the first sweep.
    outbox.emit(fixtureEvent("evt_setup"));
    await pollerOver([targetFor(outbox)]).sweep();

    // History stays history; the install's own report is delivered.
    expect(eventIds()).toEqual(["evt_setup"]);
    expect(outbox.reads[0]?.cursor).toBeUndefined();
    expect(outbox.reads[1]?.cursor).toBeDefined();
  });

  test("is a no-op when the connector already has a position", async () => {
    const outbox = await fixture();
    await writeCursor(workspaceStore, wsId, "fixture-outbox", "cur_resume");

    expect(await positionOutbox(workspaceStore, targetFor(outbox), 50)).toBe(false);
    expect(outbox.reads).toHaveLength(0);
    expect(await storedCursor()).toBe("cur_resume");
  });

  test("a body that is not a poll result leaves the bootstrap to the poller", async () => {
    const outbox = await fixture();
    outbox.answerMalformed(1);

    expect(await positionOutbox(workspaceStore, targetFor(outbox), 50)).toBe(false);
    expect(await storedCursor()).toBeUndefined();

    await pollerOver([targetFor(outbox)]).sweep();
    expect(await storedCursor()).toBeDefined();
  });
});

/**
 * Run `during` once the poller has taken its position off the record and before
 * its read reaches the source: another cursor writer landing while a read is in
 * flight.
 */
function interleave(outbox: OutboxFixture, during: () => Promise<unknown>): void {
  const source = outbox.source;
  const read = source.readResource.bind(source);
  let armed = true;
  source.readResource = async (uri, opts) => {
    if (armed) {
      armed = false;
      await during();
    }
    return read(uri, opts);
  };
}

describe("the poller's cursor write", () => {
  test("a bootstrap in flight does not overwrite the install-time position", async () => {
    const outbox = await fixture();
    interleave(outbox, async () => {
      await positionOutbox(workspaceStore, targetFor(outbox), 50);
      // What `on_ready` reports, before the poller's bootstrap is answered.
      outbox.emit(fixtureEvent("evt_setup"));
    });

    // The poller's bootstrap answers a horizon past `evt_setup`, and loses to
    // the position, so the next sweep reads from before the event.
    await pollerOver([targetFor(outbox)]).sweep();
    expect(eventIds()).toEqual([]);

    await pollerOver([targetFor(outbox)]).sweep();
    expect(eventIds()).toEqual(["evt_setup"]);
  });

  test("a read in flight across an uninstall does not bring the cursor back", async () => {
    const outbox = await fixture();
    await positionOutbox(workspaceStore, targetFor(outbox), 50);
    outbox.emit(fixtureEvent("evt_before_uninstall"));
    interleave(outbox, () => clearCursor(workspaceStore, wsId, "fixture-outbox"));

    await pollerOver([targetFor(outbox)]).sweep();

    expect(await storedCursor()).toBeUndefined();
  });
});
