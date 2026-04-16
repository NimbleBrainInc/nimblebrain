import { describe, expect, it } from "bun:test";
import { filterEnvForBundle } from "../../src/bundles/env-filter.ts";

describe("filterEnvForBundle", () => {
	const hostEnv: Record<string, string> = {
		PATH: "/usr/bin",
		HOME: "/home/user",
		TMPDIR: "/tmp",
		ANTHROPIC_API_KEY: "sk-ant-secret",
		NB_API_KEY: "nb-secret-key",
		MY_CUSTOM_VAR: "custom-value",
		DATABASE_URL: "postgres://localhost/db",
	};

	it("passes through default allowlist vars", () => {
		const result = filterEnvForBundle(hostEnv);
		expect(result.PATH).toBe("/usr/bin");
		expect(result.HOME).toBe("/home/user");
		expect(result.TMPDIR).toBe("/tmp");
	});

	it("excludes secret vars not on the allowlist", () => {
		const result = filterEnvForBundle(hostEnv);
		expect(result.ANTHROPIC_API_KEY).toBeUndefined();
		expect(result.MY_CUSTOM_VAR).toBeUndefined();
		expect(result.DATABASE_URL).toBeUndefined();
	});

	it("adds explicitly opted-in vars from host env", () => {
		const result = filterEnvForBundle(hostEnv, undefined, ["MY_CUSTOM_VAR"]);
		expect(result.MY_CUSTOM_VAR).toBe("custom-value");
	});

	it("hard-denies NB_API_KEY even with explicit opt-in", () => {
		const result = filterEnvForBundle(hostEnv, undefined, ["NB_API_KEY"]);
		expect(result.NB_API_KEY).toBeUndefined();
	});

	it("merges manifest env on top of filtered host env", () => {
		const result = filterEnvForBundle(
			hostEnv,
			{ BUNDLE_SECRET: "from-manifest", PATH: "/override" },
		);
		expect(result.BUNDLE_SECRET).toBe("from-manifest");
		expect(result.PATH).toBe("/override");
	});

	it("returns only defaults when allowedEnv is empty", () => {
		const result = filterEnvForBundle(hostEnv, undefined, []);
		expect(result.PATH).toBe("/usr/bin");
		expect(result.ANTHROPIC_API_KEY).toBeUndefined();
		expect(result.MY_CUSTOM_VAR).toBeUndefined();
	});

	it("returns only defaults when allowedEnv is undefined", () => {
		const result = filterEnvForBundle(hostEnv);
		expect(result.PATH).toBe("/usr/bin");
		expect(result.MY_CUSTOM_VAR).toBeUndefined();
	});

	it("does not error when opted-in var is missing from host env", () => {
		const result = filterEnvForBundle(hostEnv, undefined, ["NONEXISTENT_VAR"]);
		expect(result.NONEXISTENT_VAR).toBeUndefined();
	});

	it("hard-denies NB_API_KEY from manifest env", () => {
		const result = filterEnvForBundle(hostEnv, { NB_API_KEY: "leaked" });
		expect(result.NB_API_KEY).toBeUndefined();
	});

	it("hard-denies NB_INTERNAL_TOKEN from manifest env", () => {
		const result = filterEnvForBundle(hostEnv, { NB_INTERNAL_TOKEN: "leaked" });
		expect(result.NB_INTERNAL_TOKEN).toBeUndefined();
	});

	it("allows non-denied keys from manifest env", () => {
		const result = filterEnvForBundle(hostEnv, { BUNDLE_SECRET: "from-manifest" });
		expect(result.BUNDLE_SECRET).toBe("from-manifest");
	});
});
