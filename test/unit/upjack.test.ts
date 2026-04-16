import { describe, expect, it } from "bun:test";
import { UpjackSource } from "../../src/tools/upjack-source.ts";
import type { UpjackManifest } from "../../src/tools/upjack-source.ts";
import { extractText } from "../../src/engine/content-helpers.ts";

const testManifest: UpjackManifest = {
	name: "crm",
	version: "1.0.0",
	entities: [
		{
			name: "contact",
			prefix: "ct_",
			fields: {
				first_name: {
					type: "string",
					description: "First name",
					required: true,
				},
				last_name: {
					type: "string",
					description: "Last name",
					required: true,
				},
				email: { type: "string", description: "Email address" },
			},
		},
	],
};

describe("UpjackSource", () => {
	it("generates CRUD tools from entity schema", async () => {
		const source = new UpjackSource("crm", testManifest);
		const tools = await source.tools();

		expect(tools).toHaveLength(5);
		const names = tools.map((t) => t.name);
		expect(names).toContain("crm__create_contact");
		expect(names).toContain("crm__read_contact");
		expect(names).toContain("crm__update_contact");
		expect(names).toContain("crm__delete_contact");
		expect(names).toContain("crm__list_contact");
	});

	it("generated tools have correct input schemas", async () => {
		const source = new UpjackSource("crm", testManifest);
		const tools = await source.tools();

		const createTool = tools.find((t) => t.name === "crm__create_contact")!;
		expect(createTool.inputSchema).toHaveProperty("properties");
		const props = (createTool.inputSchema as Record<string, unknown>)
			.properties as Record<string, unknown>;
		expect(props).toHaveProperty("first_name");
		expect(props).toHaveProperty("last_name");
		expect(props).toHaveProperty("email");

		const required = (createTool.inputSchema as Record<string, unknown>)
			.required as string[];
		expect(required).toContain("first_name");
		expect(required).toContain("last_name");
		expect(required).not.toContain("email");
	});

	it("tools have correct source field", async () => {
		const source = new UpjackSource("crm", testManifest);
		const tools = await source.tools();
		expect(tools.every((t) => t.source === "upjack:crm")).toBe(true);
	});

	it("create and read entity", async () => {
		const source = new UpjackSource("crm", testManifest);

		const createResult = await source.execute("create_contact", {
			first_name: "James",
			last_name: "Park",
			email: "james@acme.com",
		});
		expect(createResult.isError).toBe(false);
		const created = JSON.parse(extractText(createResult.content));
		expect(created.first_name).toBe("James");
		expect(created.id).toBeDefined();

		const readResult = await source.execute("read_contact", {
			id: created.id,
		});
		expect(readResult.isError).toBe(false);
		const read = JSON.parse(extractText(readResult.content));
		expect(read.first_name).toBe("James");
	});

	it("update entity", async () => {
		const source = new UpjackSource("crm", testManifest);
		const created = JSON.parse(
			extractText(
				(
					await source.execute("create_contact", {
						first_name: "A",
						last_name: "B",
					})
				).content,
			),
		);

		const updateResult = await source.execute("update_contact", {
			id: created.id,
			email: "new@email.com",
		});
		expect(updateResult.isError).toBe(false);
		const updated = JSON.parse(extractText(updateResult.content));
		expect(updated.email).toBe("new@email.com");
		expect(updated.first_name).toBe("A");
	});

	it("delete entity", async () => {
		const source = new UpjackSource("crm", testManifest);
		const created = JSON.parse(
			extractText(
				(
					await source.execute("create_contact", {
						first_name: "A",
						last_name: "B",
					})
				).content,
			),
		);

		const deleteResult = await source.execute("delete_contact", {
			id: created.id,
		});
		expect(deleteResult.isError).toBe(false);

		const readResult = await source.execute("read_contact", {
			id: created.id,
		});
		expect(readResult.isError).toBe(true);
	});

	it("list entities", async () => {
		const source = new UpjackSource("crm", testManifest);
		await source.execute("create_contact", {
			first_name: "A",
			last_name: "1",
		});
		await source.execute("create_contact", {
			first_name: "B",
			last_name: "2",
		});

		const listResult = await source.execute("list_contact", {});
		expect(listResult.isError).toBe(false);
		const list = JSON.parse(extractText(listResult.content));
		expect(list.count).toBe(2);
		expect(list.records).toHaveLength(2);
	});

	it("returns error for unknown entity", async () => {
		const source = new UpjackSource("crm", testManifest);
		const result = await source.execute("create_unknown", {});
		expect(result.isError).toBe(true);
	});

	it("returns error for not found on read", async () => {
		const source = new UpjackSource("crm", testManifest);
		const result = await source.execute("read_contact", {
			id: "nonexistent",
		});
		expect(result.isError).toBe(true);
	});

	it("generates tools for multiple entities", async () => {
		const multiManifest: UpjackManifest = {
			name: "crm",
			version: "1.0.0",
			entities: [
				{
					name: "contact",
					prefix: "ct_",
					fields: { name: { type: "string" } },
				},
				{
					name: "deal",
					prefix: "dl_",
					fields: {
						title: { type: "string" },
						value: { type: "number" },
					},
				},
			],
		};
		const source = new UpjackSource("crm", multiManifest);
		const tools = await source.tools();
		expect(tools).toHaveLength(10);
	});
});
