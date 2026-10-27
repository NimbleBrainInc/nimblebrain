/**
 * The scripted ACP agent as a child process on stdio, for tests of the stdio
 * transport. It answers every turn with the names of the environment variables
 * the process can see, so a test can check what a driver let through.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createScriptedAgent } from "./scripted-agent.ts";

const visible = Object.keys(process.env).sort().join(",");
createScriptedAgent({ script: () => [{ text: `env:${visible}` }] }).connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
