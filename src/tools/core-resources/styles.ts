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

export const CONVERSATIONS_STYLES = `
    #search { width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 14px; margin-bottom: 12px; background: var(--color-background-secondary); color: var(--color-text-primary); }
    #search:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .conv { padding: 10px 12px; border-radius: var(--border-radius-sm); cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
    .conv:hover { background: var(--color-background-tertiary); }
    .conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-date { font-size: 12px; color: var(--color-text-secondary); flex-shrink: 0; margin-left: 8px; }
    .ctx-menu { position: fixed; background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); box-shadow: 0 2px 8px rgba(0,0,0,0.12); padding: 4px 0; z-index: 100; }
    .ctx-item { padding: 6px 16px; cursor: pointer; font-size: 13px; }
    .ctx-item:hover { background: var(--color-background-tertiary); }
    .empty { color: var(--color-text-secondary); text-align: center; padding: 24px; }
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

export const USAGE_BAR_STYLES = `
    .bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; font-size: 12px; color: var(--color-text-secondary); }
    .metric { display: flex; align-items: center; gap: 4px; }
    .label { color: var(--color-text-secondary); }
    .value { font-weight: 600; color: var(--color-text-primary); }
    `;

export const USAGE_DASHBOARD_STYLES = `
    .page { padding: 32px; max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    h1 { font-family: var(--nb-font-heading); font-size: 20px; font-weight: 600; color: var(--color-text-primary); }
    #period { padding: 7px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 13px; background: var(--color-background-secondary); color: var(--color-text-primary); cursor: pointer; }
    #period:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat { background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); padding: 20px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--color-text-primary); letter-spacing: -0.5px; }
    .stat-label { font-size: 12px; color: var(--color-text-secondary); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    table { width: 100%; border-collapse: collapse; background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); overflow: hidden; }
    th { text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-background-tertiary); border-bottom: 1px solid var(--color-border-primary); }
    td { padding: 12px 16px; font-size: 13px; color: var(--color-text-primary); border-bottom: 1px solid var(--color-background-tertiary); }
    tr:last-child td { border-bottom: none; }
    .empty { color: var(--color-text-secondary); text-align: center; padding: 32px; }
    `;

export const SETTINGS_STYLES = `
    .settings-shell { display: flex; flex-direction: column; height: 100%; }
    .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--color-border-primary); background: var(--color-background-secondary); padding: 0 24px; flex-shrink: 0; }
    .tab-select { display: none; flex-shrink: 0; padding: 12px 16px; border-bottom: 1px solid var(--color-border-primary); background: var(--color-background-secondary); }
    .tab-select select { width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 14px; font-weight: 500; background: var(--color-background-primary); color: var(--color-text-primary); cursor: pointer; -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%235c5c66' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; }
    .tab-select select:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .tab { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border: none; background: none; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--color-text-secondary); border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
    .tab:hover { color: var(--color-text-primary); }
    .tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-text-primary); }
    .tab-icon { font-size: 15px; }
    .tab-label { font-size: 13px; }
    .content { flex: 1; overflow-y: auto; padding: 24px 32px; max-width: 720px; width: 100%; }
    @media (max-width: 600px) { .tab-bar { display: none; } .tab-select { display: block; } .content { padding: 16px; } }
    .loading { color: var(--color-text-secondary); text-align: center; padding: 48px 0; }
    .error { color: var(--nb-color-danger); text-align: center; padding: 48px 0; }
    .empty { color: var(--color-text-secondary); text-align: center; padding: 48px 0; }
    /* Section content styles (inherited by injected section HTML) */
    .page { max-width: 720px; }
    h1 { font-family: var(--nb-font-heading); font-size: 20px; font-weight: 600; color: var(--color-text-primary); margin-bottom: 24px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 12px; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .bundle { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); margin-bottom: 8px; }
    .bundle-name { font-weight: 500; color: var(--color-text-primary); }
    .bundle-status { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 100px; text-transform: uppercase; letter-spacing: 0.3px; }
    .bundle-status.running { background: color-mix(in srgb, var(--nb-color-success) 15%, transparent); color: var(--nb-color-success); }
    .bundle-status.stopped { background: var(--color-background-tertiary); color: var(--color-text-secondary); }
    .bundle-status.crashed { background: color-mix(in srgb, var(--nb-color-danger) 15%, transparent); color: var(--nb-color-danger); }
    .bundle-status.dead { background: color-mix(in srgb, var(--nb-color-danger) 15%, transparent); color: var(--nb-color-danger); }
    .bundle-actions button { font-size: 12px; padding: 5px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); background: var(--color-background-secondary); cursor: pointer; margin-left: 6px; color: var(--color-text-primary); transition: all 0.15s; }
    .bundle-actions button:hover { background: var(--color-background-tertiary); border-color: var(--color-border-primary); }
    select { padding: 9px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 14px; width: 100%; max-width: 360px; background: var(--color-background-secondary); color: var(--color-text-primary); cursor: pointer; }
    select:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    `;

export const MODEL_SELECTOR_STYLES = `
    select { padding: 6px 10px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); font-size: 13px; background: var(--color-background-secondary); color: var(--color-text-primary); cursor: pointer; width: 100%; }
    select:focus { outline: none; border-color: var(--color-ring-primary); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    `;
