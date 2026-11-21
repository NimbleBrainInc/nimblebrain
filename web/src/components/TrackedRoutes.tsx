import { type ReactNode, useEffect } from "react";
import { createRoutesFromChildren, Routes, useLocation } from "react-router-dom";
import { routeViewOf } from "../lib/route-template";
import { setTelemetryRoute } from "../telemetry";

/**
 * `<Routes>` that tells telemetry which page is on screen. The template comes from
 * the same route elements the router matches, so every page is named in this one
 * place and none needs its own pageview. Telemetry decides whether to send it.
 */
export function TrackedRoutes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const view = routeViewOf(createRoutesFromChildren(children), pathname);
  const template = view?.template;
  const app = view?.app;

  // Keyed on the view's fields, since `view` itself is rebuilt every render.
  useEffect(() => {
    setTelemetryRoute(
      template === undefined ? null : { path: pathname, template, ...(app ? { app } : {}) },
    );
  }, [pathname, template, app]);

  return <Routes>{children}</Routes>;
}
