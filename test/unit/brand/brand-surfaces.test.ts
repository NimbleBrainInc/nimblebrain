import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { brandRoutes } from "../../../src/api/routes/brand.ts";
import { reinitiateParagraph, successPage } from "../../../src/api/routes/oauth-success-page.ts";
import { loadBrand } from "../../../src/brand/index.ts";
import { composeSystemPrompt, defaultIdentity } from "../../../src/prompt/compose.ts";
import { loadCoreSkills } from "../../../src/skills/loader.ts";
import type { Skill } from "../../../src/skills/types.ts";
import { colors } from "../../../web/src/theme/palette.ts";
import { ACME_BRAND } from "../../helpers/acme-brand.ts";

afterEach(() => {
  loadBrand({});
});

describe("identity — {{brand.name}}", () => {
  const soul = () => {
    const skill = loadCoreSkills().find((s) => s.manifest.name === "soul");
    if (!skill) throw new Error("soul core skill not found");
    return skill;
  };

  test("the vendored soul skill carries the template, not a name", () => {
    expect(soul().body).toContain("powered by {{brand.name}}.");
  });

  test("renders NimbleBrain when no brand is configured", () => {
    const prompt = composeSystemPrompt([soul()]);
    expect(prompt).toContain("You are a helpful assistant powered by NimbleBrain.");
    expect(prompt).not.toContain("{{brand.name}}");
  });

  test("renders the brand name in the vendored soul and in the default identity", () => {
    loadBrand({ brand: { name: "ACME" } });
    expect(composeSystemPrompt([soul()])).toContain("powered by ACME.");
    expect(composeSystemPrompt([])).toContain("powered by ACME.");
    expect(defaultIdentity()).toContain("powered by ACME.");
  });

  test("a tenant-authored core skill containing the literal is not substituted", () => {
    loadBrand({ brand: { name: "ACME" } });
    const tenant: Skill = {
      manifest: {
        name: "workspace-soul",
        description: "",
        version: "1.0.0",
        type: "context",
        priority: 1,
      },
      body: "Say {{brand.name}} verbatim.",
      sourcePath: "/tmp/workspace-soul.md",
    } as Skill;
    expect(composeSystemPrompt([tenant])).toContain("Say {{brand.name}} verbatim.");
  });
});

describe("GET /v1/brand", () => {
  const app = () => new Hono().route("/", brandRoutes());

  test("serves {} without auth when no brand is configured, publicly cacheable", async () => {
    const res = await app().request("/v1/brand");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("serves the resolved brand", async () => {
    const resolved = loadBrand({ brand: ACME_BRAND });
    const res = await app().request("/v1/brand");
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(resolved)));
  });
});

describe("OAuth pages", () => {
  const styleOf = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const hashOf = (s: string) => createHash("sha256").update(s).digest("base64");

  test("the CSP hash is of the exact style served", () => {
    loadBrand({ brand: ACME_BRAND });
    const page = successPage("Authorization complete", "/w/x/settings/connectors");
    expect(page.csp).toContain(`style-src 'sha256-${hashOf(styleOf(page.html))}'`);
  });

  test("unbranded: canonical accent, NimbleBrain wordmark and diamond", () => {
    const page = successPage("t", "/r");
    expect(styleOf(page.html)).toContain(`fill:${colors.primary[0]}`);
    expect(styleOf(page.html)).toContain(`color:${colors.primary[1]}`);
    expect(page.html).toContain("<svg");
    expect(page.html).toContain("NimbleBrain</div>");
  });

  test("branded: brand accent and background, brand wordmark, no NimbleBrain mark", () => {
    loadBrand({ brand: ACME_BRAND });
    const page = successPage("t", "/r");
    const style = styleOf(page.html);
    expect(style).toContain("fill:#B53707");
    expect(style).toContain("background:#FAF6EE");
    expect(style).toContain("color:#FF8A4C");
    expect(page.html).toContain(">ACME</div>");
    expect(page.html).not.toContain("<svg");
    expect(page.html).not.toContain("NimbleBrain");
  });

  test("the error-page line names the brand, escaped", () => {
    expect(reinitiateParagraph()).toBe("<p>Re-initiate the connection from NimbleBrain.</p>");
    loadBrand({ brand: { name: "A&B" } });
    expect(reinitiateParagraph()).toBe("<p>Re-initiate the connection from A&amp;B.</p>");
  });
});
