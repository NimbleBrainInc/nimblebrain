import { describe } from "bun:test";
import { InMemorySessionRegistry } from "../../../../src/api/session-store/memory.ts";
import { registrySpec } from "./conformance.ts";

describe("InMemorySessionRegistry — conformance", () => {
	registrySpec(async (opts) => new InMemorySessionRegistry(opts));
});
