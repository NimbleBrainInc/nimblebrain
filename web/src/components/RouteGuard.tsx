import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { roleAtLeast, type ScopedRole, useScopedRole } from "../hooks/useScopedRole";

interface RouteGuardProps {
  /** Minimum role required to render `children`. Insufficient → redirect. */
  role: ScopedRole;
  /** Where to send users who don't meet `role`. Defaults to /profile. */
  fallback?: string;
  children: ReactNode;
}

/**
 * Route-level role gate. Renders `children` only when the user's effective
 * scoped role meets the requirement; otherwise redirects (replaces history
 * so Back doesn't return to a forbidden URL).
 *
 * This is the second of three enforcement layers — the nav filter hides
 * forbidden links, this guard catches URL-hacks before render, and the
 * backend tool enforces roles independently. None of these alone is the
 * security boundary; together they're defense in depth.
 */
export function RouteGuard({ role, fallback = "/profile", children }: RouteGuardProps) {
  const current = useScopedRole();
  if (!roleAtLeast(current, role)) {
    return <Navigate to={fallback} replace />;
  }
  return <>{children}</>;
}
