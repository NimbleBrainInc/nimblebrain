import { type ReactNode, useEffect } from "react";
import { createRoutesFromChildren, useLocation, useRoutes } from "react-router-dom";
import { routeViewOf } from "../lib/route-template";
import { setTelemetryRoute } from "../telemetry";

/**
 * `<Routes>` that tells telemetry which page is on screen. The template comes from
 * the same route elements the router matches, so every page is named in this one
 * place and none needs its own pageview. Telemetry decides whether to send it.
 */
export function TrackedRoutes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // Built once per render, for both the match and the router.
  const routes = createRoutesFromChildren(children);
  const view = routeViewOf(routes, pathname);
  const template = view?.template;
  const app = view?.app;

  // Keyed on the view's fields, since `view` itself is rebuilt every render.
  useEffect(() => {
    setTelemetryRoute(template === undefined ? null : { template, ...(app ? { app } : {}) });
  }, [template, app]);

  return useRoutes(routes);
}
