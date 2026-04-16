import { describe, expect, it } from "bun:test";
import { resolveFeatures, isToolEnabled } from "../../../src/config/features.ts";

describe("identity & workspace feature flags", () => {
	describe("resolveFeatures", () => {
		it("defaults userManagement and workspaceManagement to true", () => {
			const features = resolveFeatures();
			expect(features.userManagement).toBe(true);
			expect(features.workspaceManagement).toBe(true);
		});

		it("defaults new flags to true when other flags are provided", () => {
			const features = resolveFeatures({ delegation: false });
			expect(features.userManagement).toBe(true);
			expect(features.workspaceManagement).toBe(true);
		});

		it("respects explicit userManagement: false", () => {
			const features = resolveFeatures({ userManagement: false });
			expect(features.userManagement).toBe(false);
		});

		it("respects explicit workspaceManagement: false", () => {
			const features = resolveFeatures({ workspaceManagement: false });
			expect(features.workspaceManagement).toBe(false);
		});

		it("does not affect existing flags when new flags are set", () => {
			const features = resolveFeatures({
				userManagement: false,
				workspaceManagement: false,
			});
			expect(features.bundleManagement).toBe(true);
			expect(features.skillManagement).toBe(true);
			expect(features.delegation).toBe(true);
			expect(features.toolDiscovery).toBe(true);
			expect(features.bundleDiscovery).toBe(true);
			expect(features.mcpServer).toBe(true);
			expect(features.fileContext).toBe(true);
		});
	});

	describe("isToolEnabled — userManagement", () => {
		it("disables nb__manage_users when userManagement is false", () => {
			const features = resolveFeatures({ userManagement: false });
			expect(isToolEnabled("nb__manage_users", features)).toBe(false);
		});

		it("disables unprefixed manage_users when userManagement is false", () => {
			const features = resolveFeatures({ userManagement: false });
			expect(isToolEnabled("manage_users", features)).toBe(false);
		});

		it("enables nb__manage_users when userManagement is true", () => {
			const features = resolveFeatures({ userManagement: true });
			expect(isToolEnabled("nb__manage_users", features)).toBe(true);
		});
	});

	describe("isToolEnabled — workspaceManagement", () => {
		it("disables nb__manage_workspaces when workspaceManagement is false", () => {
			const features = resolveFeatures({ workspaceManagement: false });
			expect(isToolEnabled("nb__manage_workspaces", features)).toBe(false);
			expect(isToolEnabled("manage_workspaces", features)).toBe(false);
		});

		it("enables manage_workspaces when workspaceManagement is true", () => {
			const features = resolveFeatures({ workspaceManagement: true });
			expect(isToolEnabled("nb__manage_workspaces", features)).toBe(true);
		});
	});
});
