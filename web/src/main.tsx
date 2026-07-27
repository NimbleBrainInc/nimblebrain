import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerHostFontUrls } from "./bridge/fonts";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FONT_URLS } from "./font-urls";
import { registerStaleChunkRecovery } from "./lib/stale-chunk-recovery";
import { initSentry } from "./sentry";

// Hand the built font URLs to the bridge. The `?url` imports live in font-urls.ts
// rather than in bridge/fonts.ts, which is reachable from the shared bridge
// protocol that the root unit suite exercises without web/ deps. Same seam as
// initSentry below. Unregistered, apps simply get no faces.
registerHostFontUrls(FONT_URLS);

// Initialize crash tracking before anything else so it wraps the whole app.
// No-op unless configured at runtime (see sentry.ts / config.ts). The browser
// entry is the only place @sentry/react is loaded as a value and handed to the
// otherwise-SDK-agnostic sentry.ts, so the SDK never reaches non-browser importers.
initSentry(Sentry);

// Recover a tab that outlived a deploy: a 404 on a stale hashed lazy chunk
// would otherwise white-screen the app. See stale-chunk-recovery.ts.
registerStaleChunkRecovery();

createRoot(document.getElementById("root")!, {
  // React 19 hooks: report render-time throws to Sentry (incl. ones the
  // ErrorBoundary below catches) without touching the boundary's fallback UI.
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(
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
