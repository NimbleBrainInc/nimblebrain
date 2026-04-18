import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { Tool, ToolSource } from "./types.ts";

export interface UpjackManifest {
  name: string;
  version: string;
  entities: UpjackEntity[];
}

export interface UpjackEntity {
  name: string;
  prefix: string;
  fields: Record<string, UpjackField>;
}

export interface UpjackField {
  type: string;
  description?: string;
  required?: boolean;
}

type EntityStore = Map<string, Record<string, unknown>>;

const ok = (data: unknown): ToolResult => ({
  content: textContent(JSON.stringify(data)),
  isError: false,
});
const fail = (msg: string): ToolResult => ({ content: textContent(msg), isError: true });
const idSchema = (n: string) => ({
  type: "object" as const,
  properties: { id: { type: "string", description: `${n} ID` } },
  required: ["id"],
});

export class UpjackSource implements ToolSource {
  readonly name: string;
  private stores = new Map<string, EntityStore>();
  private manifest: UpjackManifest;
  private idCounters = new Map<string, number>();

  constructor(name: string, manifest: UpjackManifest) {
    this.name = name;
    this.manifest = manifest;
    for (const entity of manifest.entities) {
      this.stores.set(entity.name, new Map());
      this.idCounters.set(entity.name, 0);
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async tools(): Promise<Tool[]> {
    return this.manifest.entities.flatMap((e) => this.crudTools(e));
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    const sep = toolName.indexOf("_");
    if (sep === -1) return fail(`Invalid tool name: ${toolName}`);
    const action = toolName.slice(0, sep);
    const entity = toolName.slice(sep + 1);
    const store = this.stores.get(entity);
    if (!store) return fail(`Unknown entity: ${entity}`);

    switch (action) {
      case "create":
        return this.doCreate(entity, store, input);
      case "read":
        return this.doRead(store, input);
      case "update":
        return this.doUpdate(store, input);
      case "delete":
        return this.doDelete(store, input);
      case "list":
        return ok({ entity, count: store.size, records: [...store.values()] });
      default:
        return fail(`Unknown action: ${action}`);
    }
  }

  private crudTools(entity: UpjackEntity): Tool[] {
    const { name } = entity;
    const props: Record<string, unknown> = {};
    const req: string[] = [];
    for (const [k, f] of Object.entries(entity.fields)) {
      props[k] = { type: f.type, description: f.description ?? k };
      if (f.required) req.push(k);
    }
    const src = `upjack:${this.name}`;
    const t = (suffix: string, desc: string, schema: Record<string, unknown>): Tool => ({
      name: `${this.name}__${suffix}_${name}`,
      description: desc,
      inputSchema: schema,
      source: src,
    });
    return [
      t("create", `Create a new ${name}`, { type: "object", properties: props, required: req }),
      t("read", `Read a ${name} by ID`, idSchema(name)),
      t("update", `Update fields on a ${name}`, {
        type: "object",
        properties: { id: { type: "string", description: `${name} ID` }, ...props },
        required: ["id"],
      }),
      t("delete", `Delete a ${name} by ID`, idSchema(name)),
      t("list", `List all ${name} records`, { type: "object", properties: {} }),
    ];
  }

  private doCreate(entity: string, store: EntityStore, input: Record<string, unknown>): ToolResult {
    const counter = (this.idCounters.get(entity) ?? 0) + 1;
    this.idCounters.set(entity, counter);
    const id = `${entity}_${counter}`;
    const record = { id, ...input };
    store.set(id, record);
    return ok(record);
  }

  private doRead(store: EntityStore, input: Record<string, unknown>): ToolResult {
    const id = String(input.id ?? "");
    const record = store.get(id);
    return record ? ok(record) : fail(`Not found: ${id}`);
  }

  private doUpdate(store: EntityStore, input: Record<string, unknown>): ToolResult {
    const id = String(input.id ?? "");
    const record = store.get(id);
    if (!record) return fail(`Not found: ${id}`);
    const { id: _, ...updates } = input;
    const updated = { ...record, ...updates };
    store.set(id, updated);
    return ok(updated);
  }

  private doDelete(store: EntityStore, input: Record<string, unknown>): ToolResult {
    const id = String(input.id ?? "");
    return store.delete(id) ? ok(`Deleted: ${id}`) : fail(`Not found: ${id}`);
  }
}
