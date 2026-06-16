import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { registerStaleChunkRecovery } from "./lib/stale-chunk-recovery";

// Recover a tab that outlived a deploy: a 404 on a stale hashed lazy chunk
// would otherwise white-screen the app. See stale-chunk-recovery.ts.
registerStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Root catch-all: a render-time throw that escapes the inner route-level
        boundary (shell/bootstrap layer, or a chunk error surfaced during
        render rather than as vite:preloadError) degrades to the fallback card
        instead of a blank white page. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
