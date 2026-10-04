import { Navigate, Route } from "react-router-dom";
import { RETIRED_IDENTITY_APP_SEGMENTS } from "./identity-apps";

/**
 * Routes, for a child of `/w/:slug`, that redirect a renamed identity view's
 * old segment to its new one (`/w/<slug>/automations` → `/w/<slug>/tasks`), so
 * a bookmark or a shared link still opens the view. Called inline inside
 * `<Routes>`: the router reads `<Route>` elements, not a component wrapping them.
 */
export function retiredIdentityAppRoutes() {
  return [...RETIRED_IDENTITY_APP_SEGMENTS].map(([from, to]) => (
    <Route key={from} path={from} element={<Navigate to={`../${to}`} replace />} />
  ));
}
