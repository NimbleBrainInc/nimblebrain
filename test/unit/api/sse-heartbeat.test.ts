import { describe, expect, test } from "bun:test";
import { startSseHeartbeat } from "../../../src/api/sse-heartbeat.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a real ReadableStream + controller so we can observe enqueues
 * exactly the way the chat handler would. Reading the stream drains
 * frames so we can assert on them.
 */
function makeStreamPair(): {
  controller: ReadableStreamDefaultController<Uint8Array>;
  read: () => Promise<string>;
} {
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controllerRef = c;
    },
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read = async (): Promise<string> => {
    let out = "";
    while (true) {
      const raced = await Promise.race<ReadableStreamReadResult<Uint8Array> | "idle">([
        reader.read(),
        sleep(5).then(() => "idle" as const),
      ]);
      if (raced === "idle") return out;
      if (raced.done) return out;
      out += decoder.decode(raced.value);
    }
  };
  return { controller: controllerRef, read };
}

describe("startSseHeartbeat", () => {
  test("emits a SSE comment frame on each tick", async () => {
    const { controller, read } = makeStreamPair();
    const heartbeat = startSseHeartbeat(controller, 15);
    await sleep(50); // Allow ~3 ticks.
    heartbeat.stop();
    controller.close();
    const out = await read();
    const pings = out.match(/: ping\n\n/g) ?? [];
    expect(pings.length).toBeGreaterThanOrEqual(2);
    expect(pings.length).toBeLessThanOrEqual(5);
  });

  test("stop() cancels further ticks", async () => {
    const { controller, read } = makeStreamPair();
    const heartbeat = startSseHeartbeat(controller, 10);
    await sleep(25);
    heartbeat.stop();
    // Drain anything enqueued before stop(), then verify no more arrive.
    const drainedBeforeStop = (await read()).match(/: ping\n\n/g)?.length ?? 0;
    expect(drainedBeforeStop).toBeGreaterThanOrEqual(1);
    await sleep(40);
    controller.close();
    const drainedAfterStop = (await read()).match(/: ping\n\n/g)?.length ?? 0;
    expect(drainedAfterStop).toBe(0);
  });

  test("stop() is idempotent", async () => {
    const { controller, read } = makeStreamPair();
    const heartbeat = startSseHeartbeat(controller, 20);
    heartbeat.stop();
    heartbeat.stop(); // must not throw
    controller.close();
    await read();
  });

  test("swallows enqueue errors after the controller is closed", async () => {
    const { controller } = makeStreamPair();
    const heartbeat = startSseHeartbeat(controller, 10);
    controller.close();
    // Next tick tries to enqueue into a closed controller — must not throw.
    await sleep(30);
    heartbeat.stop();
  });
});
