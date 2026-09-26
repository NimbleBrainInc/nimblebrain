// ---------------------------------------------------------------------------
// Content-height sizing for an app iframe that sits in a flow layout (an
// inline tool result, a section of a settings page) rather than filling a
// fixed-height slot. The frame's height follows what its content reports.
// ---------------------------------------------------------------------------

/** A frame's height until its content first reports one. */
export const DEFAULT_CONTENT_HEIGHT = 200;

// Runaway guard, NOT a layout budget. An app renders at whatever height
// its content reports, the same as it would in any other MCP host.
//
// Any bound shorter than the content hides it *silently*: CONTENT_SIZING_CSS sets
// `overflow:hidden` inside the frame and the wrapper clips too, so there is no
// scrollbar and no affordance — a truncated card is indistinguishable from a tool
// that returned less. That is why the ceiling sits far above real content instead
// of at a layout budget; it exists only so an app reporting an absurd height
// cannot mint a multi-million-pixel element.
//
// It also terminates a growth loop this component cannot otherwise stop:
// CONTENT_SIZING_CSS neutralizes `100vh` on `html,body` only, so a descendant with
// `min-height:100vh` resolves against the iframe viewport, and an app shaped as
// that element plus a trailing sibling of height K reports H+K, then H+2K, and so
// on. Such an app is misshapen for a content-sized frame either way; the guard bounds
// how badly it fails.
export const RUNAWAY_HEIGHT_GUARD = 20_000;

// Force content-based sizing in the frame.
// Full-page app templates often set height: 100vh or min-height: 100% which
// causes the iframe to report the full viewport height instead of content height.
const CONTENT_SIZING_CSS = `<style>html,body{height:auto!important;min-height:0!important;overflow:hidden!important;margin:0!important}</style>`;

// Report content height to the host from INSIDE the iframe. The app frame is
// sandboxed without `allow-same-origin` (opaque origin), so the host cannot
// read `iframe.contentDocument` to measure it — the content must report its own
// size. A ResizeObserver posts `ui/notifications/size-changed` (the ext-apps
// resize protocol the bridge already routes to `onResize`) on every content
// change plus once on start; the host floors at >0 and otherwise honors it.
// Reports `body.scrollHeight` (true content height, so the widget shrinks as
// well as grows) — NOT `documentElement.scrollHeight`, whose viewport floor
// ratchets the height and never lets it shrink. An empty root (async app,
// pre-mount) reports ~0, which the host's `onResize` lower bound ignores. This
// is host-injected wrapper markup, not app code; CSP `script-src 'unsafe-inline'`
// permits it, and `injectCSP` replaces any app-declared CSP so it always runs.
const CONTENT_RESIZE_REPORTER = `<script>(function(){function r(){try{var b=document.body;parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:b?b.scrollHeight:document.documentElement.scrollHeight}},"*");}catch(e){}}function s(){try{new ResizeObserver(r).observe(document.body||document.documentElement);}catch(e){}r();}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",s);}else{s();}})();</script>`;

/** Inject auto-sizing CSS + a content-height reporter into app HTML so full-page templates size to content, not the viewport. */
export function buildSizedHtml(html: string): string {
  const inject = `${CONTENT_SIZING_CSS}\n${CONTENT_RESIZE_REPORTER}`;
  const headPattern = /<head([^>]*)>/i;
  return headPattern.test(html)
    ? html.replace(headPattern, (m) => `${m}\n${inject}`)
    : `${inject}\n${html}`;
}
