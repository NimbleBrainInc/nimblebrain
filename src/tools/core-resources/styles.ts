/**
 * CSS constants for nb-core ui:// resources.
 *
 * Extracted verbatim from the original core-resources.ts.
 * Each resource gets BASE_STYLES + its own constant.
 */

export const BASE_STYLES = `
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; width: 100%; overflow: hidden; }
    body {
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      color: var(--color-text-primary);
      background: var(--color-background-primary);
      -webkit-font-smoothing: antialiased;
    }
    #app { height: 100%; width: 100%; overflow-y: auto; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--color-border-primary); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--color-text-secondary); }
`;

export const APP_NAV_STYLES = `
    .app { padding: 10px 12px; border-radius: var(--border-radius-sm); cursor: pointer; display: flex; align-items: center; gap: 8px; }
    .app:hover { background: var(--color-background-tertiary); }
    .app-icon { font-size: 18px; width: 24px; text-align: center; }
    .app-name { font-weight: 500; }
    .empty { color: var(--color-text-secondary); text-align: center; padding: 24px; }
    `;

export const SETTINGS_LINK_STYLES = `
    .link { padding: 10px 12px; border-radius: var(--border-radius-sm); cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--color-text-secondary); }
    .link:hover { background: var(--color-background-tertiary); color: var(--color-text-primary); }
    `;

export const MODEL_SELECTOR_STYLES = `
    select { padding: 6px 10px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 13px; background: var(--color-background-secondary); color: var(--color-text-primary); cursor: pointer; width: 100%; }
    select:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    `;
