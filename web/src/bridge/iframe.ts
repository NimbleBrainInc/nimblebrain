// ---------------------------------------------------------------------------
// MCP App Bridge — Iframe Creation Utilities
//
// Creates sandboxed iframes for MCP Apps with CSP injection per SS10.3.
// Theme CSS variables (ext-apps spec tokens + NB extension tokens) are
// injected alongside CSP so they are available at parse time in every iframe.
//
// CSP / permissions are derived from the resource's `_meta.ui.*` (ext-apps
// `io.modelcontextprotocol/ui` extension): servers declare their UI's needs,
// callers pass them through `CreateIframeOptions`, and this module honors
// them. Absence of metadata falls back to the restrictive spec-defaults so
// apps that don't opt in stay locked down.
// ---------------------------------------------------------------------------

import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps";
import type { ThemeMode } from "./theme.ts";
import { buildThemeStyleBlock, getHostThemeMode } from "./theme.ts";

/** Options for iframe creation. */
export interface CreateIframeOptions {
  /** Origins for network requests — CSP `connect-src`. */
  connectDomains?: string[];
  /** Origins for static resources — CSP `script-src`/`style-src`/`img-src`/`font-src`. */
  resourceDomains?: string[];
  /** Origins for nested iframes — CSP `frame-src`. */
  frameDomains?: string[];
  /** Allowed `<base>` URIs — CSP `base-uri`. */
  baseUriDomains?: string[];
  /** Feature permissions the app requests (camera, clipboard, etc.) — maps to iframe `allow`. */
  permissions?: McpUiResourcePermissions;
  /**
   * Whether to honor server-declared `_meta.ui.permissions` (camera, microphone,
   * geolocation). Defaults to `false` — servers cannot unilaterally grant
   * themselves device access. The host opts in after some form of consent
   * (per-workspace admin approval, per-bundle config, user prompt), staged for
   * the consent-UI follow-up in `nimblebrain-ops/research/INTERACTIVE_OAUTH_UI.md`.
   *
   * `clipboard-write` is always on — it's needed for copy/cut UX and is
   * gesture-gated by the browser; not a device-access permission.
   */
  honorServerPermissions?: boolean;
  /** App wants a visible border/background around its frame. */
  prefersBorder?: boolean;
  /** Theme mode override. Defaults to the host page's current mode. */
  themeMode?: ThemeMode;
}

/**
 * Validate a server-declared CSP domain entry. Rejects anything that could
 * inject into a CSP directive (semicolons split directives, spaces separate
 * source lists, quotes escape `<meta content="...">`, bare `*` / `'...'`
 * CSP keywords relax the policy). Domains must be `scheme://host[:port][path]`
 * URLs over http/https/ws/wss. Wildcard subdomains (`https://*.example.com`)
 * are allowed.
 */
const CSP_DOMAIN_PATTERN = /^(https?|wss?):\/\/[A-Za-z0-9.\-_~:@%?&=/*+]+$/;
export function isValidCspDomain(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === "*" || value.startsWith("'")) return false;
  if (/[\s"';]/.test(value)) return false;
  return CSP_DOMAIN_PATTERN.test(value);
}

function filterDomains(list: string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  const ok: string[] = [];
  for (const entry of list) {
    if (isValidCspDomain(entry)) {
      ok.push(entry);
    } else {
      // Loud rejection — silent drops mask bundle misconfiguration.
      console.warn(
        `[iframe-csp] dropping invalid server-declared domain: ${JSON.stringify(entry)}`,
      );
    }
  }
  return ok.length > 0 ? ok : undefined;
}

/**
 * Build the CSP policy string per SS10.3.
 *
 * Defaults mirror the ext-apps spec's "secure by default" posture — no
 * network, no nested frames, no base URI override. Server-declared
 * `_meta.ui.csp.*` fields (passed via `CreateIframeOptions`) relax these for
 * the specific origins the app needs — after validation; invalid entries
 * are dropped with a warning so a compromised or misconfigured bundle can't
 * inject additional directives via metacharacters in its declarations.
 * `blob:` is preserved on `frame-src` for inline content rendering (e.g.,
 * PDF preview of tool output).
 */
export function buildCSP(options?: CreateIframeOptions): string {
  // Validate every server-declared entry before it touches a directive. A
  // compromised bundle declaring
  // `connectDomains: ["https://x; script-src *"]` would otherwise inject a
  // second directive that relaxes script-src; `filterDomains` rejects it.
  const connectDomains = filterDomains(options?.connectDomains);
  const resourceDomains = filterDomains(options?.resourceDomains);
  const frameDomains = filterDomains(options?.frameDomains);
  const baseUriDomains = filterDomains(options?.baseUriDomains);

  const joinOrNone = (list?: string[]): string =>
    list && list.length > 0 ? list.join(" ") : "'none'";

  const connectSrc = joinOrNone(connectDomains);
  const frameSrc =
    frameDomains && frameDomains.length > 0 ? `blob: ${frameDomains.join(" ")}` : "blob:";
  const baseUri = joinOrNone(baseUriDomains);

  // Resource-src merges across script/style/img/font. Base is `'self' 'unsafe-inline'`
  // for script/style (srcdoc iframes need inline to work at all) plus `data: blob:` for
  // images/fonts; declared resourceDomains are appended.
  const resourceExtras =
    resourceDomains && resourceDomains.length > 0 ? ` ${resourceDomains.join(" ")}` : "";

  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resourceExtras}`,
    `style-src 'self' 'unsafe-inline'${resourceExtras}`,
    `img-src 'self' data: blob: https:${resourceExtras}`,
    `font-src 'self' data:${resourceExtras}`,
    `connect-src ${connectSrc}`,
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    `base-uri ${baseUri}`,
  ].join("; ");
}

/**
 * Map ext-apps permissions to the iframe `allow` attribute value.
 *
 * Server-declared camera/microphone/geolocation are IGNORED by default — a
 * remote MCP server should not be able to unilaterally grant itself device
 * access. This matches the trust posture already applied to `clipboard-read`
 * (explicitly disallowed because it's a gesture-less exfiltration vector).
 *
 * The host can opt in via `CreateIframeOptions.honorServerPermissions`.
 * The production path for that opt-in is a per-bundle workspace-config flag
 * or a user consent prompt — staged for the consent-UI follow-up.
 *
 * `clipboard-write` stays always-on: needed for copy/cut UX and gesture-gated
 * by the browser.
 */
function buildAllowAttr(
  permissions: McpUiResourcePermissions | undefined,
  honorServerPermissions: boolean,
): string {
  const features: string[] = ["clipboard-write"];
  if (honorServerPermissions && permissions) {
    if (permissions.camera) features.push("camera");
    if (permissions.microphone) features.push("microphone");
    if (permissions.geolocation) features.push("geolocation");
  }
  return features.join("; ");
}

/**
 * Inject a `<style>` block with NimbleBrain theme CSS variables into the HTML.
 *
 * Inserts into `<head>` when present, otherwise prepends (same fallback
 * pattern as `injectCSP`). The style block is generated by
 * `buildThemeStyleBlock` so theme variables are available at parse time.
 */
export function injectThemeStyles(html: string, mode: ThemeMode): string {
  const styleTag = buildThemeStyleBlock(mode);

  // Insert after <head> tag
  const headPattern = /<head(\s[^>]*)?>|<head>/i;
  if (headPattern.test(html)) {
    return html.replace(headPattern, (match) => `${match}\n${styleTag}`);
  }

  // No <head> tag — prepend (best effort for fragments)
  return `${styleTag}\n${html}`;
}

/**
 * Inject or replace a CSP meta tag in the HTML document's <head>.
 *
 * If a CSP meta tag already exists, it is replaced. Otherwise, one is
 * inserted as the first child of <head>.
 */
export function injectCSP(html: string, policy: string): string {
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;

  // Try to replace an existing CSP meta tag
  const cspPattern = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;
  if (cspPattern.test(html)) {
    return html.replace(cspPattern, metaTag);
  }

  // Insert after <head> tag
  const headPattern = /<head(\s[^>]*)?>|<head>/i;
  if (headPattern.test(html)) {
    return html.replace(headPattern, (match) => `${match}\n${metaTag}`);
  }

  // No <head> tag — prepend the meta tag (best effort for fragments)
  return `${metaTag}\n${html}`;
}

/**
 * Create a sandboxed iframe for an MCP App.
 *
 * Sandbox attributes per SS10.3:
 * - allow-scripts: JavaScript execution
 * - allow-same-origin: Needed for postMessage origin checks
 * - allow-popups: External link opening
 * - allow-popups-to-escape-sandbox: Opened popups are not sandboxed
 *
 * Explicitly NOT allowed: allow-forms, allow-top-navigation, allow-modals.
 */
export function createAppIframe(
  html: string,
  appName: string,
  options?: CreateIframeOptions,
): HTMLIFrameElement {
  const iframe = document.createElement("iframe");

  // Sandbox attributes per SS10.3
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
  );

  // Permissions Policy: clipboard-write always on (gesture-gated by browser).
  // Server-declared device permissions (camera/microphone/geolocation) are
  // off unless the host explicitly opts in via
  // `options.honorServerPermissions` — a remote MCP server doesn't get to
  // grant itself device access.
  iframe.allow = buildAllowAttr(options?.permissions, options?.honorServerPermissions ?? false);

  // Inject theme CSS variables into the HTML
  const themeMode = options?.themeMode ?? getHostThemeMode();
  const themedHtml = injectThemeStyles(html, themeMode);

  // Inject CSP derived from server-declared `_meta.ui.csp` (or strict
  // defaults when the app doesn't opt in).
  const csp = buildCSP(options);
  const securedHtml = injectCSP(themedHtml, csp);

  // Use srcdoc (not src URL) per spec
  iframe.srcdoc = securedHtml;

  // Track app name for event routing
  iframe.dataset.app = appName;

  // Default to no border; server can request a visible one via
  // `_meta.ui.prefersBorder`. The background-color pairs with the border
  // because a bare border on a transparent frame looks half-finished.
  if (options?.prefersBorder) {
    iframe.style.border = "1px solid var(--nb-border, rgba(0, 0, 0, 0.12))";
    iframe.style.background = "var(--nb-surface, #ffffff)";
  } else {
    iframe.style.border = "none";
  }

  // TODO sandbox-proxy: `_meta.ui.domain` requests a dedicated sandbox
  // origin so the app runs in a real origin rather than the `null` origin
  // of srcdoc. Requires the double-iframe pattern — outer at host origin,
  // inner at a dedicated sandbox host. Deferred to the sandbox-proxy work
  // documented in `nimblebrain-ops/research/SANDBOX_PROXY_ARCHITECTURE.md`.

  return iframe;
}
