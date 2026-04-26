import { describe, expect, it } from "bun:test";
import { resolveFeatures, isToolEnabled, isToolVisibleToRole } from "../../src/config/features.ts";

describe("resolveFeatures", () => {
	it("defaults all flags to true when called with no args", () => {
		const features = resolveFeatures();
		expect(features.bundleManagement).toBe(true);
		expect(features.skillManagement).toBe(true);
		expect(features.delegation).toBe(true);
		expect(features.toolDiscovery).toBe(true);
		expect(features.bundleDiscovery).toBe(true);
		expect(features.mcpServer).toBe(true);
	});

	it("merges partial config correctly", () => {
		const features = resolveFeatures({ delegation: false });
		expect(features.delegation).toBe(false);
		expect(features.bundleManagement).toBe(true);
		expect(features.skillManagement).toBe(true);
		expect(features.toolDiscovery).toBe(true);
	});

});

describe("isToolEnabled", () => {
	it("returns false for nb__delegate when delegation is disabled", () => {
		const features = resolveFeatures({ delegation: false });
		expect(isToolEnabled("nb__delegate", features)).toBe(false);
	});

	it("returns true for nb__status (not feature-gated)", () => {
		const features = resolveFeatures();
		expect(isToolEnabled("nb__status", features)).toBe(true);
	});

	it("returns true for unknown/unmapped tools", () => {
		const features = resolveFeatures();
		expect(isToolEnabled("unknown_tool", features)).toBe(true);
	});
});

describe("isToolVisibleToRole", () => {
	it("hides set_model_config from non-admin users", () => {
		expect(isToolVisibleToRole("nb__set_model_config", "member")).toBe(false);
		expect(isToolVisibleToRole("set_model_config", "member")).toBe(false);
	});

	it("shows set_model_config to admin users", () => {
		expect(isToolVisibleToRole("nb__set_model_config", "admin")).toBe(true);
		expect(isToolVisibleToRole("nb__set_model_config", "owner")).toBe(true);
	});

	it("hides manage_workspaces from non-admin users", () => {
		expect(isToolVisibleToRole("nb__manage_workspaces", "member")).toBe(false);
	});

	it("shows non-admin tools to all roles", () => {
		expect(isToolVisibleToRole("nb__search", "member")).toBe(true);
		expect(isToolVisibleToRole("nb__set_preferences", "member")).toBe(true);
		expect(isToolVisibleToRole("nb__manage_app", "member")).toBe(true);
	});

	it("hides admin tools when role is null (unauthenticated)", () => {
		expect(isToolVisibleToRole("nb__set_model_config", null)).toBe(false);
		expect(isToolVisibleToRole("nb__search", null)).toBe(true);
	});
});
