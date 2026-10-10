/**
 * Presentation for the OAuth success pages served by `mcp-auth` and
 * `composio-auth`, and the one line every OAuth error page ends with.
 *
 * These are the platform's only server-rendered HTML: a full-page "Connected"
 * confirmation the provider redirects a browser to, outside the SPA and
 * therefore outside its stylesheet. Both routes render the same page, so the
 * style lives here once rather than as two copies that drift.
 *
 * Colours come from the palette the shell paints — the canonical palette with
 * the deployment's brand merged over it (`web/src/theme/brand.ts`) — so the
 * contrast guard that holds the palette holds this page too, and a branded
 * deployment's page is in its own colours. The style is therefore rendered per
 * request, and the CSP that allowlists it is hashed from the same string the
 * response carries.
 *
 * The font stack names Hanken Grotesk to match the shell, but no webfont is
 * fetched: the page links no stylesheet and its CSP grants no `font-src`. The
 * name resolves only for a visitor who happens to have the face installed;
 * `system-ui` is the practical render, and the design is built to look right
 * that way.
 */

import { createHash } from "node:crypto";
import { mergePalette } from "../../../web/src/theme/brand.ts";
import { brandName, resolvedBrand } from "../../brand/index.ts";

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

function successPageStyle(): string {
  const { colors } = mergePalette(resolvedBrand());
  const [bg, bgDark] = colors.background;
  const [fg, fgDark] = colors.foreground;
  const [muted, mutedDark] = colors["muted-foreground"];
  const [accent, accentDark] = colors.primary;
  return `html,body{margin:0;height:100%}
body{font-family:'Hanken Grotesk',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:${bg};color:${fg};display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box;-webkit-font-smoothing:antialiased}
.h{font-family:'Hanken Grotesk',system-ui,sans-serif;font-size:clamp(2.5rem,6.5vw,4.25rem);font-weight:500;letter-spacing:-0.02em;margin:0;animation:rise .35s ease-out both}
.wm{margin-top:1.5rem;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:${muted};font-weight:700;display:flex;align-items:center;gap:.55rem;animation:rise .35s ease-out .08s both}
.wm svg{width:.65rem;height:.65rem;display:block;fill:${accent}}
.fb{position:fixed;bottom:1.25rem;font-size:.75rem;color:${muted};margin:0;font-weight:500}
.fb a{color:${fg};text-decoration:none;border-bottom:1px dotted ${muted}}
.fb a:hover{color:${accent};border-bottom-color:${accent}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-color-scheme:dark){body{background:${bgDark};color:${fgDark}}.wm{color:${mutedDark}}.fb{color:${mutedDark}}.fb a{color:${fgDark};border-bottom-color:${mutedDark}}.fb a:hover{color:${accentDark};border-bottom-color:${accentDark}}}
@media (prefers-reduced-motion:reduce){.h,.wm{animation:none}}`;
}

/**
 * CSP for a success page carrying `style`. The default platform CSP
 * (`default-src 'none'`) blocks inline `<style>`, so the page would render
 * unstyled without this override. It allowlists exactly the one inline style
 * block served, by sha256 of that string, and nothing else: no scripts, no
 * fonts, no images, no fetches. The dotted "go back" anchor needs no directive
 * (CSP does not gate `<a href>`); the meta-refresh redirect needs no directive
 * (CSP does not gate `http-equiv="refresh"`).
 */
function successPageCsp(style: string): string {
  const sha256 = createHash("sha256").update(style).digest("base64");
  return `default-src 'none'; style-src 'sha256-${sha256}'; frame-ancestors 'none'; base-uri 'none'`;
}

/** A rendered success page and the CSP that admits exactly its style. */
export interface SuccessPage {
  html: string;
  csp: string;
}

/**
 * Render the page. Both callers serve the identical document apart from the
 * `<title>`; each sends `csp` as the response's `Content-Security-Policy`.
 *
 * Every interpolation is escaped here rather than by the caller. `returnUrl`
 * lands in an `http-equiv="refresh"` content attribute and an `href`, `title`
 * in an element body, the brand name in the wordmark; none is
 * attacker-controlled, but a function that renders HTML from its arguments
 * should not depend on remembering which of them arrive pre-escaped.
 *
 * The diamond beside the wordmark is NimbleBrain's mark, so it renders only
 * when no brand name is configured.
 */
export function successPage(title: string, returnUrl: string): SuccessPage {
  const style = successPageStyle();
  const safeTitle = escapeHtml(title);
  const safeUrl = escapeHtml(returnUrl);
  const mark =
    resolvedBrand().name === undefined
      ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0L12 6L6 12L0 6Z"/></svg>'
      : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeUrl}">
<style>${style}</style></head>
<body>
<h1 class="h">You're in.</h1>
<div class="wm">${mark}${escapeHtml(brandName())}</div>
<p class="fb">not redirecting? <a href="${safeUrl}">go back &rarr;</a></p>
</body></html>`;
  return { html, csp: successPageCsp(style) };
}

/** The closing line of every OAuth error page: where to go to try again. */
export function reinitiateParagraph(): string {
  return `<p>Re-initiate the connection from ${escapeHtml(brandName())}.</p>`;
}
