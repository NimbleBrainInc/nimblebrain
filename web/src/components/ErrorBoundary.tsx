import { Component, type ErrorInfo, type ReactNode } from "react";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { toSlug } from "../lib/workspace-slug";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (!this.state.hasError) return;
    const prev = prevProps.resetKeys ?? [];
    const curr = this.props.resetKeys ?? [];
    if (prev.length !== curr.length || prev.some((k, i) => k !== curr[i])) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return <ErrorFallback />;
    }
    return this.props.children;
  }
}

/**
 * What a failed render shows. Each way out is a full page load, which clears
 * the failed render. A workspace that fails to render would reopen from `/`
 * (the app opens the last workspace used here), so the way out is the viewer's
 * other workspaces, each by its own address; opening one makes it the last.
 * The root boundary sits outside the router and every provider, so this reads
 * the address from `window.location`, and the workspace list is empty there.
 */
function ErrorFallback() {
  const { workspaces } = useWorkspaceContext();
  const failing = /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1];
  const others = workspaces.filter((ws) => toSlug(ws.id) !== failing);
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
      <p className="text-lg font-medium">Something went wrong</p>
      <p className="text-sm text-muted-foreground">
        An unexpected error occurred while rendering this page.
      </p>
      <a
        href={window.location.href}
        className="text-sm underline underline-offset-4 hover:text-foreground text-muted-foreground"
      >
        Reload
      </a>
      {others.length > 0 && (
        <nav aria-label="Open another workspace" className="mt-2 flex flex-col items-center gap-1">
          <p className="text-xs text-muted-foreground">Or open another workspace</p>
          {others.map((ws) => (
            <a
              key={ws.id}
              href={`/w/${toSlug(ws.id)}/`}
              data-testid="error-other-workspace"
              className="text-sm underline underline-offset-4 hover:text-foreground text-muted-foreground"
            >
              {ws.name}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
