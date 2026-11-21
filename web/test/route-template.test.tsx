import { describe, expect, test } from "bun:test";
import { createRoutesFromChildren, Route } from "react-router-dom";
import { routeViewOf } from "../src/lib/route-template";

const routes = createRoutesFromChildren(
  <>
    <Route path="/" element={null} />
    <Route path="/w/:slug" element={null}>
      <Route index element={null} />
      <Route path="app/crm" handle={{ app: "crm" }} element={null} />
      <Route path="settings" element={null}>
        <Route path="members" element={null} />
      </Route>
      <Route path="*" element={null} />
    </Route>
    <Route path="/org" element={null}>
      <Route path="workspaces/:slug" element={null} />
    </Route>
    <Route path="*" element={null} />
  </>,
);

describe("routeViewOf", () => {
  test("joins the matched patterns, never the path", () => {
    expect(routeViewOf(routes, "/w/acme-x")).toEqual({ template: "/w/:slug" });
    expect(routeViewOf(routes, "/w/acme-x/settings/members")?.template).toBe(
      "/w/:slug/settings/members",
    );
    expect(routeViewOf(routes, "/org/workspaces/acme-x")?.template).toBe("/org/workspaces/:slug");
    expect(routeViewOf(routes, "/")?.template).toBe("/");
  });

  test("names an unmatched page by its splat", () => {
    expect(routeViewOf(routes, "/w/acme-x/nope/rec_1")?.template).toBe("/w/:slug/*");
    expect(routeViewOf(routes, "/elsewhere/rec_1")?.template).toBe("/*");
  });

  test("carries the app a route's handle names", () => {
    expect(routeViewOf(routes, "/w/acme-x/app/crm")).toEqual({
      template: "/w/:slug/app/crm",
      app: "crm",
    });
  });
});
