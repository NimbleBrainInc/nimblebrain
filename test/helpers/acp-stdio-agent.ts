/**
 * NimbleBrain's reference ACP agent as a child process on stdio, for tests of
 * the stdio transport. Its echo model answers every turn with the names of
 * the environment variables the process can see, so a test can check what a
 * driver let through.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createNimbleBrainAcpAgent } from "../../src/execution/acp-agent/agent.ts";
import { createEchoModel } from "./echo-model.ts";

const visible = Object.keys(process.env).sort().join(",");
const agent = createNimbleBrainAcpAgent({
  resolveModel: () =>
    createEchoModel({ responses: Array.from({ length: 10 }, () => ({ text: `env:${visible}` })) }),
});
agent.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
