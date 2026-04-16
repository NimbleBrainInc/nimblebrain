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
      font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
      font-size: 14px;
      line-height: 1.5;
      color: var(--color-text-primary, #171717);
      background: var(--color-background-primary, #faf9f7);
      -webkit-font-smoothing: antialiased;
    }
    #app { height: 100%; width: 100%; overflow-y: auto; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--color-border-primary, #e5e5e5); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--color-text-secondary, #737373); }
`;

export const CONVERSATIONS_STYLES = `
    #search { width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 14px; margin-bottom: 12px; background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); }
    #search:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .conv { padding: 10px 12px; border-radius: var(--border-radius-sm, 0.5rem); cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
    .conv:hover { background: var(--color-background-tertiary, #f8f7f5); }
    .conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-date { font-size: 12px; color: var(--color-text-secondary, #737373); flex-shrink: 0; margin-left: 8px; }
    .ctx-menu { position: fixed; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); box-shadow: 0 2px 8px rgba(0,0,0,0.12); padding: 4px 0; z-index: 100; }
    .ctx-item { padding: 6px 16px; cursor: pointer; font-size: 13px; }
    .ctx-item:hover { background: var(--color-background-tertiary, #f8f7f5); }
    .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 24px; }
    `;

export const APP_NAV_STYLES = `
    .app { padding: 10px 12px; border-radius: var(--border-radius-sm, 0.5rem); cursor: pointer; display: flex; align-items: center; gap: 8px; }
    .app:hover { background: var(--color-background-tertiary, #f8f7f5); }
    .app-icon { font-size: 18px; width: 24px; text-align: center; }
    .app-name { font-weight: 500; }
    .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 24px; }
    `;

export const SETTINGS_LINK_STYLES = `
    .link { padding: 10px 12px; border-radius: var(--border-radius-sm, 0.5rem); cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--color-text-secondary, #737373); }
    .link:hover { background: var(--color-background-tertiary, #f8f7f5); color: var(--color-text-primary, #171717); }
    `;

export const USAGE_BAR_STYLES = `
    .bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; font-size: 12px; color: var(--color-text-secondary, #737373); }
    .metric { display: flex; align-items: center; gap: 4px; }
    .label { color: var(--color-text-secondary, #737373); }
    .value { font-weight: 600; color: var(--color-text-primary, #171717); }
    `;

export const USAGE_DASHBOARD_STYLES = `
    .page { padding: 32px; max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); }
    #period { padding: 7px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 13px; background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); cursor: pointer; }
    #period:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat { background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.75rem); padding: 20px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--color-text-primary, #171717); letter-spacing: -0.5px; }
    .stat-label { font-size: 12px; color: var(--color-text-secondary, #737373); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    table { width: 100%; border-collapse: collapse; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.75rem); overflow: hidden; }
    th { text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-background-primary, #faf9f7); border-bottom: 1px solid var(--color-border-primary, #e5e5e5); }
    td { padding: 12px 16px; font-size: 13px; color: var(--color-text-primary, #171717); border-bottom: 1px solid var(--color-background-tertiary, #f8f7f5); }
    tr:last-child td { border-bottom: none; }
    .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 32px; }
    `;

export const SETTINGS_STYLES = `
    .settings-shell { display: flex; flex-direction: column; height: 100%; }
    .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--color-border-primary, #e5e5e5); background: var(--color-background-secondary, #ffffff); padding: 0 24px; flex-shrink: 0; }
    .tab-select { display: none; flex-shrink: 0; padding: 12px 16px; border-bottom: 1px solid var(--color-border-primary, #e5e5e5); background: var(--color-background-secondary, #ffffff); }
    .tab-select select { width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 14px; font-weight: 500; background: var(--color-background-primary, #faf9f7); color: var(--color-text-primary, #171717); cursor: pointer; -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%23737373' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; }
    .tab-select select:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    .tab { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border: none; background: none; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--color-text-secondary, #737373); border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
    .tab:hover { color: var(--color-text-primary, #171717); }
    .tab.active { color: var(--color-text-primary, #171717); border-bottom-color: var(--color-text-primary, #171717); }
    .tab-icon { font-size: 15px; }
    .tab-label { font-size: 13px; }
    .content { flex: 1; overflow-y: auto; padding: 24px 32px; max-width: 720px; width: 100%; }
    @media (max-width: 600px) { .tab-bar { display: none; } .tab-select { display: block; } .content { padding: 16px; } }
    .loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
    .error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
    .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
    /* Section content styles (inherited by injected section HTML) */
    .page { max-width: 720px; }
    h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 24px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .bundle { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.625rem); margin-bottom: 8px; }
    .bundle-name { font-weight: 500; color: var(--color-text-primary, #171717); }
    .bundle-status { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 100px; text-transform: uppercase; letter-spacing: 0.3px; }
    .bundle-status.running { background: color-mix(in srgb, var(--nb-color-success, #059669) 15%, transparent); color: var(--nb-color-success, #059669); }
    .bundle-status.stopped { background: var(--color-background-tertiary, #f8f7f5); color: var(--color-text-secondary, #737373); }
    .bundle-status.crashed { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 15%, transparent); color: var(--nb-color-danger, #dc2626); }
    .bundle-status.dead { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 15%, transparent); color: var(--nb-color-danger, #dc2626); }
    .bundle-actions button { font-size: 12px; padding: 5px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); background: var(--color-background-secondary, #ffffff); cursor: pointer; margin-left: 6px; color: var(--color-text-primary, #171717); transition: all 0.15s; }
    .bundle-actions button:hover { background: var(--color-background-tertiary, #f8f7f5); border-color: var(--color-border-primary, #e5e5e5); }
    select { padding: 9px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 14px; width: 100%; max-width: 360px; background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); cursor: pointer; }
    select:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    `;

export const MODEL_SELECTOR_STYLES = `
    select { padding: 6px 10px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 13px; background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); cursor: pointer; width: 100%; }
    select:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
    `;

export const HOME_DASHBOARD_STYLES = `
    .page { padding: 32px 24px; max-width: 720px; margin: 0 auto; }

    /* Greeting + date */
    .greeting {
      font-family: var(--nb-font-heading, Georgia, serif);
      font-size: 1.75rem; font-weight: 600;
      color: var(--color-text-primary, #171717); line-height: 1.3;
    }
    .date { font-size: 13px; color: var(--color-text-secondary, #737373); margin-top: 2px; margin-bottom: 20px; }

    /* Lede */
    .lede {
      font-style: italic; font-size: 15px; line-height: 1.6;
      color: var(--color-text-primary, #171717); opacity: 0.85; margin-bottom: 28px;
    }

    /* Section dividers */
    .section-divider {
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
      color: var(--color-text-secondary, #737373);
      border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
      padding-bottom: 6px; margin-top: 24px; margin-bottom: 12px;
    }

    /* Section items */
    .section-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 8px 0; font-size: 14px;
      color: var(--color-text-primary, #171717); line-height: 1.5;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 6px;
    }
    .item-text { flex: 1; }
    .item-text strong { font-weight: 600; }
    .item-text code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12px; background: var(--color-background-tertiary, #f8f7f5);
      padding: 1px 5px; border-radius: 3px;
    }
    .item-action {
      flex-shrink: 0; font-size: 13px;
      color: var(--color-text-accent, #0055FF); text-decoration: none;
      white-space: nowrap; margin-left: 8px;
    }
    .item-action:hover { text-decoration: underline; }

    /* Refresh banner */
    .refresh-banner {
      display: none; align-items: center; justify-content: space-between;
      padding: 8px 16px; margin-bottom: 16px;
      border-radius: var(--border-radius-sm, 0.5rem);
      background: var(--color-background-tertiary, #f8f7f5);
      font-size: 13px; color: var(--color-text-secondary, #737373);
    }
    .refresh-banner.visible { display: flex; }
    .refresh-banner button {
      font-size: 12px; padding: 4px 12px;
      border: 1px solid var(--color-border-primary, #e5e5e5);
      border-radius: var(--border-radius-sm, 0.5rem);
      background: var(--color-background-secondary, #ffffff); cursor: pointer;
      color: var(--color-text-primary, #171717); transition: background 0.15s;
    }
    .refresh-banner button:hover { background: var(--color-background-tertiary, #f8f7f5); }

    /* Error */
    .error-box { text-align: center; padding: 48px 24px; color: var(--color-text-secondary, #737373); }
    .error-box p { margin-bottom: 16px; }
    .retry-btn {
      font-size: 13px; padding: 6px 16px;
      border: 1px solid var(--color-border-primary, #e5e5e5);
      border-radius: var(--border-radius-sm, 0.5rem);
      background: var(--color-background-secondary, #ffffff); cursor: pointer;
      color: var(--color-text-primary, #171717);
    }
    .retry-btn:hover { background: var(--color-background-tertiary, #f8f7f5); }

    /* Skeleton */
    @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
    .skel {
      background: var(--color-border-primary, #e5e5e5);
      border-radius: var(--border-radius-sm, 0.5rem);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .skel-greeting { width: 55%; height: 28px; margin-bottom: 8px; }
    .skel-date { width: 30%; height: 14px; margin-bottom: 20px; }
    .skel-lede { width: 90%; height: 18px; margin-bottom: 28px; }
    .skel-divider { width: 25%; height: 12px; margin-top: 24px; margin-bottom: 12px; }
    .skel-item { width: 80%; height: 16px; margin-bottom: 10px; }
    `;

export const HOME_BRIEFING_INLINE_STYLES = `
    .inline-briefing { padding: 16px; max-width: 720px; }

    .greeting {
      font-family: var(--nb-font-heading, Georgia, serif);
      font-size: 1.25rem; font-weight: 600;
      color: var(--color-text-primary, #171717); line-height: 1.3; margin-bottom: 8px;
    }

    .lede {
      font-style: italic; font-size: 14px; line-height: 1.5;
      color: var(--color-text-primary, #171717); opacity: 0.85; margin-bottom: 16px;
    }

    .section-divider {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.7px;
      color: var(--color-text-secondary, #737373);
      border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
      padding-bottom: 4px; margin-top: 14px; margin-bottom: 8px;
    }

    .section-item {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 4px 0; font-size: 13px;
      color: var(--color-text-primary, #171717); line-height: 1.4;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
    .item-text { flex: 1; }
    .item-text strong { font-weight: 600; }
    .item-text code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px; background: var(--color-background-tertiary, #f8f7f5);
      padding: 1px 4px; border-radius: 3px;
    }
    `;
