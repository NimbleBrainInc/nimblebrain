import { afterEach, describe, expect, it } from "bun:test";
import { parsePositiveIntEnv } from "../../../src/api/mcp-server.ts";

const ENV_NAME = "__MCP_TEST_PARSE_INT__";

describe("parsePositiveIntEnv", () => {
	afterEach(() => {
		delete process.env[ENV_NAME];
	});

	it("returns the fallback when the env var is unset", () => {
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});

	it("returns the fallback for an empty string", () => {
		process.env[ENV_NAME] = "";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});

	it("parses a valid positive integer", () => {
		process.env[ENV_NAME] = "1800000";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(1_800_000);
	});

	// The footgun this guard exists for: a typo like `8h` parses as NaN under
	// the previous parseInt path, which then silently disabled eviction
	// because every comparison against NaN is false.
	it("returns the fallback for non-numeric input", () => {
		process.env[ENV_NAME] = "8h";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});

	it("returns the fallback for zero", () => {
		process.env[ENV_NAME] = "0";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});

	it("returns the fallback for a negative integer", () => {
		process.env[ENV_NAME] = "-1";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});

	it("returns the fallback for a decimal", () => {
		process.env[ENV_NAME] = "1.5";
		expect(parsePositiveIntEnv(ENV_NAME, 42)).toBe(42);
	});
});
