import { describe, expect, it } from "bun:test";
import {
  MAX_PROMPT_RESOURCE_TEMPLATES,
  readableRecordTemplates,
} from "../../../src/tools/resource-schemes.ts";

const t = (uriTemplate: string) => ({ uriTemplate, name: uriTemplate });

describe("readableRecordTemplates", () => {
  it("keeps a connector's own templates in the server's order", () => {
    const out = readableRecordTemplates([t("crm://contacts/{id}"), t("crm://deals/{id}")]);
    expect(out.map((x) => x.uriTemplate)).toEqual(["crm://contacts/{id}", "crm://deals/{id}"]);
  });

  it("drops templates in a scheme the host resolves itself", () => {
    const out = readableRecordTemplates([
      t("skill://acme-crm/{name}"),
      t("UI://acme-crm/{view}"),
      t("crm://contacts/{id}"),
    ]);
    expect(out.map((x) => x.uriTemplate)).toEqual(["crm://contacts/{id}"]);
  });

  it("drops duplicates, schemeless and over-long templates", () => {
    const out = readableRecordTemplates([
      t("crm://contacts/{id}"),
      t(" crm://contacts/{id} "),
      t("contacts/{id}"),
      t(`crm://${"x".repeat(300)}`),
    ]);
    expect(out.map((x) => x.uriTemplate)).toEqual(["crm://contacts/{id}"]);
  });

  it("keeps at most the per-app cap", () => {
    const many = Array.from({ length: MAX_PROMPT_RESOURCE_TEMPLATES + 5 }, (_, i) =>
      t(`crm://kind${i}/{id}`),
    );
    expect(readableRecordTemplates(many)).toHaveLength(MAX_PROMPT_RESOURCE_TEMPLATES);
  });
});
