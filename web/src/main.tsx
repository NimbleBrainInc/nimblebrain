import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Stale-chunk recovery. Hashed lazy chunks (e.g. the streamdown/Shiki
// `highlighted-body` code-block module, loaded on demand when a message
// contains a code block) are deleted when a new build deploys. A tab that
// outlived a deploy 404s on its next dynamic import and throws "Failed to
// fetch dynamically imported module" — an unhandled rejection that white-
// screens the app. Vite dispatches `vite:preloadError` for exactly this:
// reload once to pick up the new index.html + current chunk hashes. A short
// time guard prevents a reload loop when the asset is genuinely unreachable
// (offline, or a deploy still mid-flight with no pod serving assets yet).
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "nb:last-chunk-reload";
  const now = Date.now();
  const last = Number(sessionStorage.getItem(KEY) ?? "0");
  if (now - last < 10_000) return; // already reloaded recently — don't loop
  event.preventDefault(); // we're handling it via reload; suppress the throw
  sessionStorage.setItem(KEY, String(now));
  window.location.reload();
});

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
