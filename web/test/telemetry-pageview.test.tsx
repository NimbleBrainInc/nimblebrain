// ---------------------------------------------------------------------------
// Route pageviews: an identified deployment sends `$pageview` naming the route
// template the router matched, once per template change; an anonymous one sends
// none. No property of an identified event, URL or path, carries the real path.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { CaptureResult } from "posthog-js";
import type { NavigateFunction } from "react-router-dom";
import { defineHappyDomErrorClasses } from "./happy-dom";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
defineHappyDomErrorClasses();

const SLUG = "acme-x";
const OTHER_SLUG = "globex-y";

/** The router's current path, which the fake posthog-js reads as it would `window.location`. */
const at = { path: "/" };

// Events as they would leave the browser: posthog-js adds its URL properties from
// the real location, then runs the `before_send` the shell passed to `init`.
const sent: CaptureResult[] = [];
let beforeSend: ((e: CaptureResult | null) => CaptureResult | null) | undefined;

mock.module("posthog-js", () => ({
  default: {
    init: (_key: string, options: { before_send: typeof beforeSend }) => {
      beforeSend = options.before_send;
    },
    register: () => {},
    identify: () => {},
    group: () => {},
    reset: () => {},
    capture: (event: string, properties: Record<string, unknown> = {}) => {
      const origin = window.location.origin;
      const out = beforeSend?.({
        uuid: "u",
        event,
        properties: {
          $current_url: `${origin}${at.path}?chat=conv_1#top`,
          $pathname: at.path,
          $host: "localhost",
          $referrer: `${origin}/w/${SLUG}/context/conv_9`,
          $prev_pageview_pathname: `/w/${SLUG}/context/conv_9`,
          $session_entry_url: `${origin}/w/${SLUG}/context/conv_9`,
          title: "Acme",
          ...properties,
        },
        $set_once: {
          $initial_current_url: `${origin}/w/${SLUG}/context/conv_9?chat=conv_1`,
          $initial_pathname: `/w/${SLUG}/context/conv_9`,
          $initial_referrer: "https://idp.example/callback/code_123",
        },
      });
      if (out) sent.push(out);
    },
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, useLocation, useNavigate } = await import("react-router-dom");
// The key is read when the module loads, so set it first.
window.__NB_CONFIG__ = { posthog: { key: "phc_test", enabled: "true" } };
const telemetry = await import("../src/telemetry");
const { TrackedRoutes } = await import("../src/components/TrackedRoutes");

let navigate: NavigateFunction | null = null;
function Probe() {
  at.path = useLocation().pathname;
  navigate = useNavigate();
  return null;
}

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeAll(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/w/${SLUG}/context/conv_9`]}>
        <Probe />
        <TrackedRoutes>
          <Route path="/" element={null} />
          <Route path="/w/:slug" element={null}>
            <Route index element={null} />
            <Route path="tasks" handle={{ app: "tasks" }} element={null} />
            <Route path="app/crm" handle={{ app: "crm" }} element={null} />
            <Route path="context/:convId" element={null} />
          </Route>
          <Route path="*" element={null} />
        </TrackedRoutes>
      </MemoryRouter>,
    );
  });
});

afterAll(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function go(path: string): Promise<void> {
  await act(async () => {
    navigate!(path);
  });
}

const pageviews = () => sent.filter((e) => e.event === "$pageview");

describe("route pageviews", () => {
  test("an anonymous install sends none", async () => {
    telemetry.initTelemetry("install-1");
    await go(`/w/${SLUG}/app/crm`);
    await go(`/w/${SLUG}`);
    expect(pageviews()).toEqual([]);
  });

  test("identifying sends the page on screen as its template", () => {
    telemetry.initTelemetry("install-1", { userId: "usr_1" });
    expect(pageviews()).toHaveLength(1);
    const [view] = pageviews();
    expect(view?.properties.$pathname).toBe("/w/:slug");
    expect(view?.properties.$current_url).toBe(`${window.location.origin}/w/:slug`);
    expect(view?.properties.app).toBeUndefined();
  });

  test("a route change sends the new template, with the app an app route renders", async () => {
    sent.length = 0;
    await go(`/w/${SLUG}/app/crm?target=crm://contacts/c1`);
    expect(pageviews()).toHaveLength(1);
    const [view] = pageviews();
    expect(view?.properties.$pathname).toBe("/w/:slug/app/crm");
    expect(view?.properties.$current_url).toBe(`${window.location.origin}/w/:slug/app/crm`);
    expect(view?.properties.app).toBe("crm");

    await go(`/w/${SLUG}/tasks`);
    expect(pageviews()[1]?.properties.app).toBe("tasks");
  });

  test("a change that keeps the template sends nothing", async () => {
    await go(`/w/${SLUG}/context/conv_1`);
    sent.length = 0;
    await go(`/w/${SLUG}/context/conv_2`);
    await go(`/w/${OTHER_SLUG}/context/conv_2`);
    expect(pageviews()).toEqual([]);
  });

  test("no property carries the real path, a slug or an id", async () => {
    sent.length = 0;
    await go(`/w/${OTHER_SLUG}/app/crm`);
    telemetry.captureEvent("web.chat_sent", { resumed: false });

    expect(sent.map((e) => e.event)).toEqual(["$pageview", "web.chat_sent"]);
    for (const event of sent) {
      const payload = JSON.stringify(event);
      for (const real of [SLUG, OTHER_SLUG, "conv_", "code_123", "?", "#"]) {
        expect(payload).not.toContain(real);
      }
      // The page on screen is its template; any other page keeps only its origin.
      expect(event.properties.$current_url).toBe(`${window.location.origin}/w/:slug/app/crm`);
      expect(event.properties.$pathname).toBe("/w/:slug/app/crm");
      expect(event.properties.$referrer).toBe(window.location.origin);
      expect(event.properties.$session_entry_url).toBe(window.location.origin);
      expect(event.properties.$prev_pageview_pathname).toBeUndefined();
      expect(event.$set_once?.$initial_current_url).toBe(window.location.origin);
      expect(event.$set_once?.$initial_pathname).toBeUndefined();
      expect(event.$set_once?.$initial_referrer).toBe("https://idp.example");
    }
    expect(sent[0]?.properties.title).toBeUndefined();
  });

  test("after sign-out, no pageview is sent", async () => {
    telemetry.resetTelemetry();
    sent.length = 0;
    await go(`/w/${SLUG}/tasks`);
    expect(pageviews()).toEqual([]);
  });
});
