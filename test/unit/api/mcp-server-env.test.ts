import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parsePositiveIntEnv } from "../../../src/api/mcp-server.ts";
import { log } from "../../../src/observability/log.ts";

const ENV_NAME = "__MCP_TEST_PARSE_INT__";

describe("parsePositiveIntEnv", () => {
	// Failure cases deliberately exercise log.warn. Capture instead of letting
	// the yellow lines stream to stderr — both to keep test output clean and to
	// assert the warning actually fires when the input is rejected. Restore on
	// each test so an early `expect` failure can't leak the patched log.warn
	// into unrelated tests.
	let warned: string[];
	let originalWarn: typeof log.warn;

	beforeEach(() => {
		warned = [];
		originalWarn = log.warn;
		log.warn = (msg: string) => warned.push(msg);
	});

	afterEach(() => {
		log.warn = originalWarn;
		delete process.env[ENV_NAME];
	});

	it("returns the fallback when the env var is unset", () => {
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toEqual([]);
	});

	it("returns the fallback for an empty string", () => {
		process.env[ENV_NAME] = "";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toEqual([]);
	});

	it("parses a valid positive integer", () => {
		process.env[ENV_NAME] = "1800000";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(1_800_000);
		expect(warned).toEqual([]);
	});

	// The two failure modes this guard exists for:
	//   - `parseInt("8h", 10)` previously returned `8` (an 8 ms TTL — every
	//     session evicted on the next sweep).
	//   - `Number("8h")` returns `NaN`, which silently disables eviction.
	// Both are bad; both are now rejected with a warning + fallback.
	it("rejects non-numeric input with a warning", () => {
		process.env[ENV_NAME] = "8h";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(`[mcp] ignoring invalid ${ENV_NAME}="8h"`);
	});

	it("rejects zero with a warning", () => {
		process.env[ENV_NAME] = "0";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(`[mcp] ignoring invalid ${ENV_NAME}="0"`);
	});

	it("rejects a negative integer with a warning", () => {
		process.env[ENV_NAME] = "-1";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(`[mcp] ignoring invalid ${ENV_NAME}="-1"`);
	});

	it("rejects a decimal with a warning", () => {
		process.env[ENV_NAME] = "1.5";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(`[mcp] ignoring invalid ${ENV_NAME}="1.5"`);
	});
});
