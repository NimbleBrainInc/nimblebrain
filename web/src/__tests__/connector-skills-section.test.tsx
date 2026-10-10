// ---------------------------------------------------------------------------
// ConnectorSkillsSection — the read-only list of skills a workspace's
// connectors put into the agent's context (Settings → Skills, workspace
// vantage). Lists through `listConnectorSkills`, reads a body through
// `readConnectorSkill` only when its row opens. bun:test + happy-dom.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";
import type { ConnectorOverlaySkill, PublishedConnectorSkill } from "../api/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let nextOverlays: ConnectorOverlaySkill[] = [];
let nextPublished: PublishedConnectorSkill[] = [];
const listConnectorSkills = mock<typeof ApiClient.listConnectorSkills>(async () => ({
  overlays: nextOverlays,
  published: nextPublished,
}));
const readConnectorSkill = mock<typeof ApiClient.readConnectorSkill>(async (_ws, server, name) => ({
  kind: "published",
  body: `Body of ${server}/${name}.`,
}));

mock.module("../api/client", () => ({
  ...realClient,
  listConnectorSkills,
  readConnectorSkill,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ConnectorSkillsSection, connectorSkillGroups } = await import(
  "../pages/settings/ConnectorSkillsSection"
);

const ALWAYS: PublishedConnectorSkill = {
  server: "acme-docs",
  name: "house-style",
  description: "Formatting rules",
  uri: "skill://house-style/SKILL.md",
  loadingStrategy: "always",
  priority: 20,
  toolAffinity: ["acme-docs__*"],
  mechanism: "always",
};

const DYNAMIC: PublishedConnectorSkill = {
  server: "acme-docs",
  name: "publishing",
  description: "How to publish",
  uri: "skill://publishing/SKILL.md",
  loadingStrategy: "dynamic",
  priority: 60,
  toolAffinity: ["acme-docs__publish"],
  triggers: ["publish this"],
  mechanism: "tool_affinity",
};

const OVERLAY: ConnectorOverlaySkill = {
  server: "acme-mail",
  name: "mail-usage",
  description: "Mail guidance",
  source: "connector:acme-mail@v0.1.0",
  toolAffinity: ["acme-mail__*"],
};

let unmount: (() => void) | null = null;

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(ConnectorSkillsSection, { workspaceId: "ws_a" }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

/** Let the body read and the markdown renderer finish inside `act`. */
function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(el: Element | null | undefined): Promise<void> {
  return act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  unmount?.();
  unmount = null;
  nextOverlays = [];
  nextPublished = [];
  listConnectorSkills.mockClear();
  readConnectorSkill.mockClear();
});

describe("connectorSkillGroups", () => {
  test("groups by server in name order and states how each skill loads", () => {
    const groups = connectorSkillGroups({ overlays: [OVERLAY], published: [DYNAMIC, ALWAYS] });
    expect(groups.map((g) => g.server)).toEqual(["acme-docs", "acme-mail"]);
    const [docs, mail] = groups;
    expect(docs!.skills.map((s) => s.name)).toEqual(["house-style", "publishing"]);
    expect(docs!.skills[0]!.loads.text).toBe("Always on · every conversation");
    expect(docs!.skills[1]!.loads).toEqual({ text: "On tool match", mono: "acme-docs__publish" });
    expect(docs!.skills[1]!.details).toContain('triggers "publish this"');
    expect(mail!.skills[0]!.loads).toEqual({ text: "On first tool call", mono: "acme-mail__*" });
    expect(mail!.skills[0]!.details).toEqual(["curated overlay", "connector:acme-mail@v0.1.0"]);
  });
});

describe("ConnectorSkillsSection", () => {
  test("says so when no connected server publishes skills", async () => {
    const container = await mount();
    expect(listConnectorSkills).toHaveBeenCalledWith("ws_a");
    expect(container.textContent).toContain("No connected server publishes skills");
  });

  test("lists each server's skills without reading a body until a row opens", async () => {
    nextPublished = [ALWAYS, DYNAMIC];
    nextOverlays = [OVERLAY];
    const container = await mount();
    const text = container.textContent ?? "";
    expect(text).toContain("acme-docs");
    expect(text).toContain("acme-mail");
    expect(text).toContain("house-style");
    expect(text).toContain("Always on");
    expect(readConnectorSkill).not.toHaveBeenCalled();
    // Read-only: nothing on the section offers to change a skill.
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => /edit|delete|turn (on|off)/i.test(l))).toBe(false);

    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("publishing"),
    );
    await click(row);
    await settle();
    expect(readConnectorSkill).toHaveBeenCalledWith("ws_a", "acme-docs", "publishing");
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Body of acme-docs/publishing.");
    expect(container.textContent).toContain("skill://publishing/SKILL.md");
  });

  test("shows a read failure on the row", async () => {
    nextPublished = [ALWAYS];
    readConnectorSkill.mockImplementationOnce(async () => {
      throw new Error("acme-docs did not return house-style.");
    });
    const container = await mount();
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("house-style"),
    );
    await click(row);
    await settle();
    expect(container.textContent).toContain("did not return house-style");
  });
});
