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
import { brandFontOrigins, fontOrigin } from "./fonts.ts";
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
   * (per-workspace admin approval, per-connector config, user prompt), staged for
   * the consent-UI follow-up in an internal design note.
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
      // Loud rejection — silent drops mask connector misconfiguration.
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
 * are dropped with a warning so a compromised or misconfigured connector can't
 * inject additional directives via metacharacters in its declarations.
 * `blob:` is preserved on `frame-src` for inline content rendering (e.g.,
 * PDF preview of tool output).
 */
export function buildCSP(options?: CreateIframeOptions): string {
  // Validate every server-declared entry before it touches a directive. A
  // compromised connector declaring
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
    // `'self'` matches NOTHING here: the frame is `srcdoc` without
    // `allow-same-origin`, so it has an opaque origin. Naming the host origin
    // explicitly is what lets the app load the `styles.css.fonts` files the
    // host serves. Fonts are inert resources and the host already authors this
    // document, so this grants no reach the frame didn't already have. A
    // tenant brand's font origins join for the same reason: the host sends
    // those faces too.
    ["font-src 'self' data:", fontOrigin(), ...brandFontOrigins(), resourceExtras.trim()]
      .filter(Boolean)
      .join(" "),
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
 * The production path for that opt-in is a per-connector workspace-config flag
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
 * The same-origin page every app frame nests its app in (`web/public/app-frame.html`). Its URL
 * carries no query, so the app's base URL and its document's referrer name this fixed page, never
 * the person's place in the shell (`?chat=`, an app's target). It is served by its own handler,
 * with no fallback to the shell, and only this origin may frame it.
 */
export const APP_FRAME_PATH = "/app-frame.html";

/** The marker the frame page carries, so a missing page (a 404, a fallback) never hosts an app. */
const APP_FRAME_MARKER = "data-app-frame";

/** An app frame's nested app, and who hears what the app posts. */
interface NestedApp {
  app: HTMLIFrameElement | null;
  handlers: Set<(event: MessageEvent) => void>;
}

const nestedApps = new WeakMap<HTMLIFrameElement, NestedApp>();

/**
 * The window the app in `iframe` runs in: the nested frame of an app frame, or, for a frame
 * `createAppIframe` did not make, the frame's own window. Post to it, and trust only messages
 * whose `source` it is.
 */
export function appWindowOf(iframe: HTMLIFrameElement): Window | null {
  const nested = nestedApps.get(iframe);
  return nested ? (nested.app?.contentWindow ?? null) : iframe.contentWindow;
}

/**
 * Post `message` to the app in `iframe`. An MCP Apps client accepts a message only from its
 * parent, so for an app frame the frame page's own `postToApp` sends it; a post made from the
 * shell would name the shell as its sender and be dropped. For any other frame it is posted
 * to the frame's window. The app's origin is opaque, so the target origin can only be `*`.
 */
export function postToAppWindow(iframe: HTMLIFrameElement, message: unknown): void {
  if (!nestedApps.has(iframe)) {
    iframe.contentWindow?.postMessage(message, "*");
    return;
  }
  const page = iframe.contentWindow;
  if (page && "postToApp" in page && typeof page.postToApp === "function") page.postToApp(message);
}

/**
 * Hear what the app in `iframe` posts. An app posts to its parent, which for an app frame is the
 * frame page, so its messages arrive there; for any other frame they arrive on this window.
 * Returns the stop function.
 */
export function onAppMessage(
  iframe: HTMLIFrameElement,
  handler: (event: MessageEvent) => void,
): () => void {
  const nested = nestedApps.get(iframe);
  if (!nested) {
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }
  nested.handlers.add(handler);
  return () => nested.handlers.delete(handler);
}

/**
 * Create the frame an MCP App renders in.
 *
 * The element returned is an app frame: a same-origin frame at `APP_FRAME_PATH`, which the caller
 * sizes and places. Once that page loads, the app's own frame is built inside it, a `srcdoc`
 * frame whose base URL and referrer are the frame page's. Placed directly in the shell, a
 * `srcdoc` frame takes the shell's URL as its base URL, so any app could read where the person
 * is. The frame page is not sandboxed, because sandbox flags pass to a nested frame and the app
 * needs scripts; its one script is the `postToApp` the shell sends through, and the app cannot
 * reach it from its opaque origin. Post with `postToAppWindow`, hear the app with `onAppMessage`,
 * and trust only messages whose `source` is `appWindowOf`.
 *
 * The app's frame is sandboxed:
 * - allow-scripts: JavaScript execution (the app is an interactive UI)
 * - allow-popups: External link opening
 * - allow-popups-to-escape-sandbox: Opened popups are not sandboxed
 * - allow-downloads: Lets an app save bytes it already holds (e.g. the
 *   Files app's "Download" action, which fetches via the bridge and saves
 *   from a blob: URL). Gesture-gated by the browser; without it Chromium
 *   silently blocks the download.
 *
 * Deliberately NOT granted:
 * - allow-same-origin: App HTML is third-party (connector / remote-MCP-server
 *   authored). With `srcdoc`, granting this makes the frame SAME-ORIGIN with
 *   the host — the app could then read `window.parent` (DOM, globals), ride
 *   the host session cookie on same-origin `/v1` + `/mcp` fetches, and remove
 *   its own sandbox: a full sandbox escape. Withheld, the app runs in an
 *   opaque origin. The bridge keys trust on `event.source ===
 *   appWindowOf(iframe)` (not origin), so postMessage still works; a real
 *   per-app origin, if ever needed, comes from the sandbox-proxy pattern in
 *   the TODO below — never from same-origin.
 * - allow-forms, allow-top-navigation.
 * - allow-modals: withheld deliberately. A sandboxed app calling native
 *   `<dialog>.showModal()` / `alert()` / `print()` throws here and white-screens
 *   the app — do NOT grant this to "fix" that. App UIs must use a non-modal
 *   overlay instead (e.g. @nimblebrain/synapse `Drawer`, a `<div role="dialog">`).
 */
export function createAppIframe(
  html: string,
  appName: string,
  options?: CreateIframeOptions,
): HTMLIFrameElement {
  // Permissions Policy: clipboard-write always on (gesture-gated by browser).
  // Server-declared device permissions (camera/microphone/geolocation) are
  // off unless the host explicitly opts in via
  // `options.honorServerPermissions` — a remote MCP server doesn't get to
  // grant itself device access. A permission reaches a nested frame only
  // when every frame above it allows it, so both frames carry the same list.
  const allow = buildAllowAttr(options?.permissions, options?.honorServerPermissions ?? false);

  // Inject theme CSS variables into the HTML
  const themeMode = options?.themeMode ?? getHostThemeMode();
  const themedHtml = injectThemeStyles(html, themeMode);

  // Inject CSP derived from server-declared `_meta.ui.csp` (or strict
  // defaults when the app doesn't opt in).
  const csp = buildCSP(options);
  const securedHtml = injectCSP(themedHtml, csp);

  const iframe = document.createElement("iframe");
  iframe.allow = allow;
  iframe.src = APP_FRAME_PATH;

  // Track app name for event routing
  iframe.dataset.app = appName;

  // Default to no border; server can request a visible one via
  // `_meta.ui.prefersBorder`. The background-color pairs with the border
  // because a bare border on a transparent frame looks half-finished.
  if (options?.prefersBorder) {
    iframe.style.border = "1px solid var(--border)";
    iframe.style.background = "var(--card)";
  } else {
    iframe.style.border = "none";
  }

  const nested: NestedApp = { app: null, handlers: new Set() };
  nestedApps.set(iframe, nested);

  // Each load of the frame page (moving the element in the DOM reloads it)
  // builds the app afresh, as a reload of a `srcdoc` frame would.
  iframe.addEventListener("load", () => {
    const page = iframe.contentDocument;
    const pageWindow = iframe.contentWindow;
    if (!page?.body?.hasAttribute(APP_FRAME_MARKER) || !pageWindow) return;
    pageWindow.addEventListener("message", (event) => {
      for (const handler of nested.handlers) handler(event);
    });

    // Built from the frame page's own document, so the app's base URL is that page's.
    const app = page.createElement("iframe");
    app.sandbox.add(
      "allow-scripts",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-downloads",
    );
    app.allow = allow;
    app.title = appName;
    app.style.cssText = "display:block;width:100%;height:100%;border:0";
    // Use srcdoc (not src URL) per spec
    app.srcdoc = securedHtml;
    nested.app = app;
    page.body.replaceChildren(app);
  });

  // TODO sandbox-proxy: `_meta.ui.domain` requests a dedicated sandbox
  // origin so the app runs in a real origin rather than the `null` origin
  // of srcdoc. That puts the frame page at a dedicated sandbox host.
  // Deferred to the sandbox-proxy work documented in an internal design note.

  return iframe;
}
