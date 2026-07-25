/**
 * Presentation for the OAuth success pages served by `mcp-auth` and
 * `composio-auth`.
 *
 * These are the platform's only server-rendered HTML: a full-page "Connected"
 * confirmation the provider redirects a browser to, outside the SPA and
 * therefore outside its stylesheet. Both routes render the same page, so the
 * style lives here once rather than as two copies that drift.
 *
 * The values are hand-written rather than read from `web/src/theme/palette.ts`,
 * which is the palette's stated single source. That is a known gap, not a
 * decision: this is server code and nothing in `src/` imports from `web/`
 * today, so closing it means introducing that edge deliberately. Tracked in
 * #764 — until then, a palette change has to be mirrored here by hand, and the
 * theme contrast guard does not reach these colours.
 *
 * The font stack names Hanken Grotesk to match the shell, but no webfont is
 * fetched: the page links no stylesheet and {@link SUCCESS_PAGE_CSP} grants no
 * `font-src`. The name resolves only for a visitor who happens to have the face
 * installed; `system-ui` is the practical render, and the design is built to
 * look right that way.
 */

import { createHash } from "node:crypto";

const SUCCESS_PAGE_STYLE = `html,body{margin:0;height:100%}
body{font-family:'Hanken Grotesk',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#ffffff;color:#09090b;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box;-webkit-font-smoothing:antialiased}
.h{font-family:'Hanken Grotesk',system-ui,sans-serif;font-size:clamp(2.5rem,6.5vw,4.25rem);font-weight:500;letter-spacing:-0.02em;margin:0;animation:rise .35s ease-out both}
.wm{margin-top:1.5rem;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#5c5c66;font-weight:700;display:flex;align-items:center;gap:.55rem;animation:rise .35s ease-out .08s both}
.wm svg{width:.65rem;height:.65rem;display:block}
.fb{position:fixed;bottom:1.25rem;font-size:.75rem;color:#5c5c66;margin:0;font-weight:500}
.fb a{color:#09090b;text-decoration:none;border-bottom:1px dotted #82828c}
.fb a:hover{color:#0055FF;border-bottom-color:#0055FF}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-color-scheme:dark){body{background:#000000;color:#fafafa}.wm{color:#9b9ba4}.fb{color:#9b9ba4}.fb a{color:#fafafa;border-bottom-color:#9b9ba4}.fb a:hover{color:#4d90ff;border-bottom-color:#4d90ff}}
@media (prefers-reduced-motion:reduce){.h,.wm{animation:none}}`;

const SUCCESS_PAGE_STYLE_SHA256 = createHash("sha256").update(SUCCESS_PAGE_STYLE).digest("base64");

/**
 * CSP for the OAuth success page. The default platform CSP
 * (`default-src 'none'`) blocks inline `<style>`, so the page would render
 * unstyled in production without this override. We allowlist exactly the one
 * inline style block we serve, by sha256 computed from the constant above — so
 * editing the style cannot silently break the page — and nothing else: no
 * scripts, no fonts, no images, no fetches. The dotted "go back" anchor needs
 * no directive (CSP does not gate `<a href>`); the meta-refresh redirect needs
 * no directive (CSP does not gate `http-equiv="refresh"`).
 */
export const SUCCESS_PAGE_CSP = `default-src 'none'; style-src 'sha256-${SUCCESS_PAGE_STYLE_SHA256}'; frame-ancestors 'none'; base-uri 'none'`;

/**
 * Render the page as a string. Both callers serve the identical document apart from the
 * `<title>`, so the markup lives here with the style it depends on — including
 * the one brand value in it, the wordmark's `fill`.
 *
 * `returnUrl` must already be HTML-escaped: it is interpolated into both an
 * `http-equiv="refresh"` content attribute and an `href`, and the callers hold
 * the escaping helper.
 */
export function successPageHtml(title: string, escapedReturnUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${escapedReturnUrl}">
<style>${SUCCESS_PAGE_STYLE}</style></head>
<body>
<h1 class="h">You're in.</h1>
<div class="wm"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0L12 6L6 12L0 6Z" fill="#0055FF"/></svg>NimbleBrain</div>
<p class="fb">not redirecting? <a href="${escapedReturnUrl}">go back &rarr;</a></p>
</body></html>`;
}
