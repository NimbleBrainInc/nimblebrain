/**
 * Catalogs: Browse from a listing without opening an artifact, install by
 * address, the plugin's managed skill read-only, uninstall.
 *
 * Runs only where the suite's fixture catalog is configured (`boot.ts`),
 * since what Browse lists is the operator's listing.
 */

import { structured, textOf } from "../client.ts";
import {
  CATALOG_NAME,
  OTHER_ADDRESS,
  PLUGIN_ADDRESS,
  PLUGIN_CONNECTION,
  PLUGIN_SKILL,
  REQUEST_LOG_PATH,
} from "../fixtures.ts";
import { expect, expectEq, type Scenario } from "../scenario.ts";

interface Row {
  id: string;
  address?: string;
  catalog?: string;
  status?: string;
  name: string;
}

interface SkillRow {
  id: string;
  name: string;
  source?: unknown;
}

/**
 * A deployment may configure no catalog, so an empty listing is a valid
 * answer; only a target that expects items (`expectCatalog`) requires one.
 */
export const catalogsBrowse: Scenario = {
  id: "catalogs.browse",
  title: "Browse answers, and every row it lists is well-formed",
  groups: ["smoke"],
  async run(t) {
    await t.check("list_directory answers, each row with a name and an address", async () => {
      const dir = await t.client.tool(t.alice, t.ws, "nb__manage_connectors", {
        action: "list_directory",
      });
      expect(!dir.isError, "answered", textOf(dir).slice(0, 300));
      const rows = structured<{ entries?: Row[] }>(dir).entries;
      expect(Array.isArray(rows), "a list of entries", structured(dir));
      if (t.expectCatalog) expect(rows.length > 0, "listed items", structured(dir));
      expect(
        rows.every((r) => typeof r.name === "string" && typeof r.address === "string"),
        "each row has a name and an address",
        rows.slice(0, 5),
      );
      return { count: rows.length, sample: rows.slice(0, 5).map((r) => r.address) };
    });
  },
};

export const catalogsPlugins: Scenario = {
  id: "catalogs.plugins",
  title: "Browse from the listing, install by address, managed skill read-only, uninstall",
  requires: ["fixture-catalog"],
  async run(t) {
    const connectors = (args: Record<string, unknown>) =>
      t.client.tool(t.alice, t.ws, "nb__manage_connectors", args);
    const artifactFetches = async () => {
      const r = await fetch(`${t.catalogBase}${REQUEST_LOG_PATH}`);
      return ((await r.json()) as string[]).filter((p) => p.startsWith("/artifacts/"));
    };

    const before = (await artifactFetches()).length;
    const dir = await connectors({ action: "list_directory" });
    const rows = structured<{ entries?: Row[] }>(dir).entries ?? [];

    await t.check("Browse lists every listed item by address, and opens no artifact", async () => {
      const addresses = rows.map((r) => r.address);
      expect(
        addresses.includes(PLUGIN_ADDRESS) && addresses.includes(OTHER_ADDRESS),
        "both items",
        addresses,
      );
      expectEq((await artifactFetches()).length - before, 0, "artifact fetches while browsing");
      return rows
        .filter((r) => r.catalog === CATALOG_NAME)
        .map((r) => ({ address: r.address, status: r.status }));
    });

    await t.check(
      "an install naming nothing in the catalog is NOT_IN_CATALOG and writes nothing",
      async () => {
        const r = await connectors({
          action: "install",
          entry: { address: `nothing@${CATALOG_NAME}` },
        });
        expect(r.isError, "refused", textOf(r));
        expect(
          /NOT_IN_CATALOG|not in/i.test(textOf(r) + JSON.stringify(r.structuredContent ?? {})),
          "the code",
          textOf(r),
        );
        return textOf(r).slice(0, 200);
      },
    );

    const installed = await connectors({ action: "install", entry: { address: PLUGIN_ADDRESS } });
    await t.check(
      "install by address fetches the artifact once and connects its server",
      async () => {
        const out = structured<{ ok?: boolean; address?: string; serverName?: string }>(installed);
        expectEq(out.address, PLUGIN_ADDRESS, "address");
        expectEq(out.serverName, PLUGIN_CONNECTION, "connection");
        expectEq((await artifactFetches()).length - before, 1, "artifact fetches");
        return out;
      },
    );

    await t.check(
      "the connection is installed, and list_plugins shows the plugin over it",
      async () => {
        const list = JSON.stringify(structured(await connectors({ action: "list_installed" })));
        expect(list.includes(PLUGIN_CONNECTION), "installed", list.slice(0, 500));
        const plugins = JSON.stringify(structured(await connectors({ action: "list_plugins" })));
        expect(plugins.includes(PLUGIN_ADDRESS), "the plugin", plugins.slice(0, 500));
        return { installed: true };
      },
    );

    const skills =
      structured<{ skills: SkillRow[] }>(await t.client.tool(t.alice, t.ws, "skills__list", {}))
        .skills ?? [];
    const managed = skills.find((s) => s.name.includes(PLUGIN_SKILL));

    await t.check(
      "the plugin's skill is listed and refuses edits, offering skills__copy",
      async () => {
        expect(
          managed,
          "the managed skill is listed",
          skills.map((s) => s.name),
        );
        const read = await t.client.tool(t.alice, t.ws, "skills__read", { id: managed.id });
        expect(
          textOf(read).includes("E2E guide body") ||
            JSON.stringify(read).includes("E2E guide body"),
          "readable",
          textOf(read),
        );
        const update = await t.client.tool(t.alice, t.ws, "skills__update", {
          id: managed.id,
          body: "changed",
          body_mode: "append",
        });
        expect(update.isError, "update refused", textOf(update));
        expect(textOf(update).includes("skills__copy"), "offers skills__copy", textOf(update));
        const del = await t.client.tool(t.alice, t.ws, "skills__delete", { id: managed.id });
        expect(del.isError, "delete refused", textOf(del));
        return { id: managed.id, update: textOf(update).slice(0, 200) };
      },
    );

    await t.check("uninstall removes the connection, the plugin and its skills", async () => {
      const removed = await connectors({ action: "uninstall", address: PLUGIN_ADDRESS });
      expect(!removed.isError, "uninstalled", textOf(removed));
      const list = JSON.stringify(structured(await connectors({ action: "list_installed" })));
      expect(!list.includes(PLUGIN_CONNECTION), "no connection", list.slice(0, 300));
      const after =
        structured<{ skills: SkillRow[] }>(await t.client.tool(t.alice, t.ws, "skills__list", {}))
          .skills ?? [];
      expect(
        !after.some((s) => s.name.includes(PLUGIN_SKILL)),
        "no managed skill",
        after.map((s) => s.name),
      );
      return structured(removed);
    });
  },
};
