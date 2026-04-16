import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export interface SessionInfo {
  authenticated: boolean;
  user?: { id: string; email: string; displayName: string; orgRole?: string };
}

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: SessionInfo | null;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo | null {
  return useContext(SessionContext);
}
