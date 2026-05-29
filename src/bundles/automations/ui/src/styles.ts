export const STYLES = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { height: 100%; width: 100%; overflow: hidden; }
body {
  font-family: var(--font-sans, 'Inter', system-ui, -apple-system, sans-serif);
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-text-primary, #171717);
  background: var(--color-background-primary, #faf9f7);
  -webkit-font-smoothing: antialiased;
}
.app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-border-primary, #e5e5e5); border-radius: 3px; }

@keyframes breathe { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.header {
  position: sticky; top: 0; z-index: 10;
  background: var(--color-background-primary, #faf9f7);
  padding: 20px 20px 12px;
  flex-shrink: 0;
}
.header-top { display: flex; justify-content: space-between; align-items: center; }
.header-title {
  font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
  font-size: 22px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.3;
}
.header-lede { font-size: 14px; color: var(--color-text-secondary, #737373); margin-top: 2px; }

.create-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border: 1px solid var(--color-text-accent, #0055FF);
  border-radius: 20px; background: transparent;
  color: var(--color-text-accent, #0055FF);
  font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: background 0.15s, color 0.15s; white-space: nowrap;
}
.create-btn:hover { background: var(--color-text-accent, #0055FF); color: #fff; }
.create-btn svg { width: 14px; height: 14px; }

.content { flex: 1; overflow-y: auto; padding: 0 20px 20px; }

.section-header {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary, #737373); margin: 16px 0 8px;
}
.section-header:first-child { margin-top: 0; }

.auto-list { display: flex; flex-direction: column; gap: 8px; animation: fadeIn 0.2s ease; }

.auto-card {
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  background: var(--color-background-secondary, #ffffff);
  padding: 12px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
  cursor: pointer;
}
.auto-card:hover {
  border-color: color-mix(in srgb, var(--color-text-accent, #0055FF) 40%, transparent);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.auto-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.auto-card-info { flex: 1; min-width: 0; }
.auto-card-name {
  font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px;
}
.auto-card-schedule { font-size: 12px; color: var(--color-text-secondary, #737373); margin-top: 2px; }
.auto-card-meta {
  display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px;
  font-size: 12px; color: var(--color-text-secondary, #737373);
}
.auto-card-meta span { display: inline-flex; align-items: center; gap: 4px; }
.auto-card-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: flex-start; }

.dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.dot-success { background: #22c55e; }
.dot-failure { background: #ef4444; }
.dot-timeout { background: #eab308; }
.dot-disabled { background: #a3a3a3; }
.dot-backoff { background: #f97316; }
.dot-running { background: #3b82f6; animation: breathe 1.5s ease-in-out infinite; }
.dot-skipped { background: #a3a3a3; }

.backoff-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 500; color: #f97316;
  background: color-mix(in srgb, #f97316 10%, transparent);
  border: 1px solid color-mix(in srgb, #f97316 25%, transparent);
  border-radius: 12px; padding: 2px 8px;
}

.btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: 14px; background: transparent;
  color: var(--color-text-secondary, #737373);
  font-size: 11px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s; white-space: nowrap;
}
.btn:hover { border-color: var(--color-text-accent, #0055FF); color: var(--color-text-accent, #0055FF); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-danger {
  border-color: color-mix(in srgb, var(--nb-color-danger, #dc2626) 40%, transparent);
  color: var(--nb-color-danger, #dc2626);
}
.btn-danger:hover { background: var(--nb-color-danger, #dc2626); color: #fff; border-color: var(--nb-color-danger, #dc2626); }

.run-list { display: flex; flex-direction: column; gap: 4px; animation: fadeIn 0.2s ease; }
.run-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: var(--border-radius-sm, 0.5rem);
  font-size: 13px; transition: background 0.1s; cursor: pointer;
}
.run-row:hover { background: color-mix(in srgb, var(--color-border-primary, #e5e5e5) 30%, transparent); }
.run-name { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-time { font-size: 12px; color: var(--color-text-secondary, #737373); flex-shrink: 0; }
.run-duration { font-size: 12px; color: var(--color-text-secondary, #737373); flex-shrink: 0; min-width: 48px; text-align: right; }

.run-expanded {
  padding: 8px 12px 12px 30px;
  font-size: 12px; color: var(--color-text-secondary, #737373);
  animation: fadeIn 0.15s ease;
}
.run-expanded pre {
  background: var(--color-background-primary, #faf9f7);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 10px 12px; margin: 6px 0;
  font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  max-height: 200px; overflow-y: auto;
}
.run-expanded-meta {
  display: flex; gap: 16px; flex-wrap: wrap; margin-top: 6px;
  font-size: 11px;
}
.run-expanded-meta span { display: inline-flex; align-items: center; gap: 4px; }

.empty-state { text-align: center; padding: 64px 24px; color: var(--color-text-secondary, #737373); }
.empty-state-icon { margin-bottom: 12px; }
.empty-state-title {
  font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
  font-size: 16px; font-weight: 500; letter-spacing: -0.025em; margin-bottom: 6px;
}
.empty-state-desc { font-size: 13px; line-height: 1.5; }

.skel {
  background: var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  animation: breathe 3s ease-in-out infinite;
}
.skel-card { height: 72px; }
.skel-row { height: 36px; }
.loading-list { display: flex; flex-direction: column; gap: 8px; }

.error-banner {
  padding: 10px 14px; margin: 0 0 12px;
  background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-danger, #dc2626) 25%, transparent);
  border-radius: var(--border-radius-sm, 0.5rem);
  color: var(--nb-color-danger, #dc2626); font-size: 13px;
}

.confirm-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100;
  display: flex; align-items: center; justify-content: center; animation: fadeIn 0.15s ease;
}
.confirm-panel {
  background: var(--color-background-secondary, #ffffff);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 24px; max-width: 360px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15); animation: fadeIn 0.2s ease;
}
.confirm-title {
  font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
  font-size: 16px; font-weight: 500; letter-spacing: -0.025em; margin-bottom: 8px;
}
.confirm-desc { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 16px; line-height: 1.5; }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }

.detail-header {
  display: flex; align-items: center; gap: 12px; margin-bottom: 4px;
}
.back-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: 50%; background: transparent; cursor: pointer;
  color: var(--color-text-secondary, #737373);
  transition: border-color 0.15s, color 0.15s;
  flex-shrink: 0;
}
.back-btn:hover { border-color: var(--color-text-accent, #0055FF); color: var(--color-text-accent, #0055FF); }

.detail-name {
  font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
  font-size: 20px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.3;
  flex: 1; min-width: 0;
}
.detail-desc {
  font-size: 13px; color: var(--color-text-secondary, #737373);
  margin-bottom: 12px; line-height: 1.5;
}

.detail-section {
  margin-top: 16px;
}
.detail-section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary, #737373); margin-bottom: 8px;
}

.detail-prompt {
  background: var(--color-background-secondary, #ffffff);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 12px 14px;
  font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  max-height: 240px; overflow-y: auto;
  cursor: pointer; position: relative;
}
.detail-prompt:hover {
  border-color: color-mix(in srgb, var(--color-text-accent, #0055FF) 40%, transparent);
}
.detail-prompt-hint {
  position: absolute; top: 8px; right: 10px;
  font-size: 10px; color: var(--color-text-secondary, #737373);
  font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
  opacity: 0; transition: opacity 0.15s;
}
.detail-prompt:hover .detail-prompt-hint { opacity: 1; }

.detail-config-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.detail-config-item {
  background: var(--color-background-secondary, #ffffff);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 8px 12px; cursor: pointer;
  transition: border-color 0.15s;
}
.detail-config-item:hover {
  border-color: color-mix(in srgb, var(--color-text-accent, #0055FF) 40%, transparent);
}
.detail-config-label {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  color: var(--color-text-secondary, #737373); margin-bottom: 2px;
}
.detail-config-value {
  font-size: 13px; font-weight: 500; word-break: break-word;
}
.detail-config-value.muted { color: var(--color-text-secondary, #737373); font-weight: 400; font-style: italic; }

.detail-status-row {
  display: flex; gap: 16px; flex-wrap: wrap;
  font-size: 12px; color: var(--color-text-secondary, #737373);
  padding: 8px 0;
}
.detail-status-row span { display: inline-flex; align-items: center; gap: 4px; }

.detail-actions {
  display: flex; gap: 8px; margin: 16px 0;
}

.inline-edit-textarea {
  width: 100%; min-height: 80px; padding: 12px 14px;
  border: 2px solid var(--color-text-accent, #0055FF);
  border-radius: var(--border-radius-sm, 0.5rem);
  background: var(--color-background-secondary, #ffffff);
  color: var(--color-text-primary, #171717);
  font-size: 13px; line-height: 1.6;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  resize: vertical; outline: none;
}
.inline-edit-input {
  width: 100%; padding: 4px 8px;
  border: 2px solid var(--color-text-accent, #0055FF);
  border-radius: 6px;
  background: var(--color-background-secondary, #ffffff);
  color: var(--color-text-primary, #171717);
  font-size: 13px; font-family: inherit;
  outline: none;
}
.inline-edit-actions {
  display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;
}

.chevron {
  display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
  transition: transform 0.15s;
}
.chevron.open { transform: rotate(90deg); }

/* ============================================================
   Two-pane reader layout (Variant 3)
   ============================================================ */

.two-pane {
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: 280px 1fr;
  overflow: hidden;
}

.rail {
  overflow-y: auto;
  border-right: 1px solid var(--color-border-primary, #e5e5e5);
  background: var(--color-background-primary, #faf9f7);
  padding-bottom: 12px;
}
.rail-section {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary, #737373);
  padding: 16px 16px 6px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}

.rail-auto-item, .rail-run-item {
  width: 100%; text-align: left; cursor: pointer;
  display: flex; gap: 8px;
  padding: 9px 16px;
  border: none; background: transparent; color: inherit;
  font-family: inherit;
  border-left: 2px solid transparent;
  transition: background 0.1s;
}
.rail-auto-item:hover, .rail-run-item:hover { background: color-mix(in srgb, var(--color-border-primary, #e5e5e5) 30%, transparent); }
.rail-auto-item.active, .rail-run-item.active {
  background: var(--color-background-secondary, #ffffff);
  border-left-color: var(--color-text-accent, #0055FF);
}

.rail-auto-item { align-items: flex-start; }
.rail-auto-item .dot { margin-top: 6px; }
.rail-auto-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rail-auto-name { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #171717); }
.rail-auto-sub { font-size: 11px; color: var(--color-text-secondary, #737373); }

.rail-run-item { flex-direction: column; align-items: stretch; gap: 3px; }
.rail-run-top { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.rail-run-name { font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-primary, #171717); }
.rail-run-time { font-size: 11px; color: var(--color-text-secondary, #737373); flex-shrink: 0; }
.rail-run-snippet {
  font-size: 12px; color: var(--color-text-secondary, #737373);
  margin-left: 16px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.rail-empty {
  font-size: 12px; color: var(--color-text-secondary, #737373);
  padding: 8px 16px 14px;
}

/* Status legend in the rail */
.legend { display: inline-flex; gap: 10px; font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--color-text-secondary, #737373); }
.legend span { display: inline-flex; align-items: center; gap: 4px; }

/* Right pane — reader */
.reader { overflow-y: auto; background: var(--color-background-secondary, #ffffff); }

.reader-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; padding: 48px 32px; text-align: center; color: var(--color-text-secondary, #737373);
}
.reader-empty-title {
  font-family: var(--nb-font-heading, Georgia, serif);
  font-size: 17px; font-weight: 500; letter-spacing: -0.02em;
  color: var(--color-text-primary, #171717); margin-bottom: 8px;
}
.reader-empty-desc { font-size: 13px; line-height: 1.5; max-width: 360px; }

.reader-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
  padding: 20px 28px 14px;
  border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
  position: sticky; top: 0; background: var(--color-background-secondary, #ffffff); z-index: 5;
}
.reader-head-meta { min-width: 0; }
.reader-head-title { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--color-text-secondary, #737373); flex-wrap: wrap; }
.reader-head-name {
  background: none; border: none; padding: 0; font: inherit; cursor: pointer;
  color: var(--color-text-primary, #171717); font-weight: 600;
  border-bottom: 1px solid transparent; transition: border-color 0.15s;
}
.reader-head-name:hover:not(:disabled) { border-bottom-color: var(--color-text-accent, #0055FF); }
.reader-head-name:disabled { cursor: default; }
.reader-head-status { color: var(--color-text-secondary, #737373); }
.reader-head-sep, .reader-head-dot { color: var(--color-border-primary, #e5e5e5); margin: 0 2px; }
.reader-head-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 10px;
  background: color-mix(in srgb, var(--color-text-secondary, #737373) 12%, transparent);
  color: var(--color-text-secondary, #737373); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.4px;
}
.reader-head-sub {
  font-size: 12px; color: var(--color-text-secondary, #737373);
  margin-top: 5px; line-height: 1.5;
}
.reader-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }

.reader-body { padding: 22px 28px 28px; }
.reader-truncation-note {
  margin-top: 20px; padding: 10px 14px;
  font-size: 12px; color: var(--color-text-secondary, #737373);
  background: var(--color-background-primary, #faf9f7);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
}
.reader-error-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--nb-color-danger, #dc2626); margin-bottom: 6px; }
.reader-error-body {
  background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-danger, #dc2626) 25%, transparent);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 10px 12px; font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  color: var(--nb-color-danger, #dc2626);
}
.reader-footer-meta {
  display: flex; gap: 16px; flex-wrap: wrap; margin-top: 22px; padding-top: 12px;
  border-top: 1px solid var(--color-border-primary, #e5e5e5);
  font-size: 11px; color: var(--color-text-secondary, #737373);
}
.reader-footer-meta span { display: inline-flex; align-items: center; gap: 4px; }

/* Rendered markdown */
.out-md {
  font-size: 14px; line-height: 1.65;
  color: var(--color-text-primary, #171717);
  max-width: 680px;
}
.out-md h1, .out-md h2, .out-md h3 {
  font-family: var(--nb-font-heading, Georgia, serif);
  font-weight: 500; letter-spacing: -0.02em;
}
.out-md h1 { font-size: 22px; margin: 0 0 6px; }
.out-md h2 { font-size: 16px; margin: 22px 0 7px; }
.out-md h3 { font-size: 14.5px; margin: 18px 0 5px; }
.out-md p { margin: 0 0 10px; }
.out-md ul, .out-md ol { margin: 0 0 12px 22px; }
.out-md li { margin-bottom: 4px; }
.out-md li > p { margin: 0; }
.out-md a { color: var(--color-text-accent, #0055FF); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--color-text-accent, #0055FF) 35%, transparent); }
.out-md a:hover { border-bottom-color: var(--color-text-accent, #0055FF); }
.out-md code {
  background: var(--color-background-primary, #faf9f7);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: 4px; padding: 1px 5px;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  font-size: 12.5px;
}
.out-md pre {
  background: var(--color-background-primary, #faf9f7);
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  padding: 12px 14px; margin: 10px 0;
  overflow-x: auto; font-size: 12.5px; line-height: 1.5;
}
.out-md pre code { background: none; border: none; padding: 0; }
.out-md blockquote {
  margin: 10px 0; padding: 6px 14px;
  border-left: 3px solid var(--color-border-primary, #e5e5e5);
  color: var(--color-text-secondary, #737373);
}
.out-md hr { border: none; border-top: 1px solid var(--color-border-primary, #e5e5e5); margin: 18px 0; }
.out-md table { border-collapse: collapse; margin: 10px 0; }
.out-md th, .out-md td { border: 1px solid var(--color-border-primary, #e5e5e5); padding: 6px 10px; font-size: 13px; text-align: left; }
.out-md th { background: var(--color-background-primary, #faf9f7); font-weight: 600; }
.out-md strong { font-weight: 600; }

/* Template chips fix: stacked card instead of single-line .btn pill */
.template-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px; margin-top: 8px;
}
.template-card {
  display: flex; flex-direction: column; align-items: flex-start;
  gap: 3px; text-align: left; white-space: normal;
  padding: 11px 13px;
  border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: var(--border-radius-sm, 0.5rem);
  background: var(--color-background-secondary, #ffffff);
  color: var(--color-text-primary, #171717);
  font-family: inherit; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.template-card:hover { border-color: var(--color-text-accent, #0055FF); }
.template-card.dashed { border-style: dashed; }
.template-card-name { font-size: 13px; font-weight: 500; }
.template-card-desc { font-size: 11px; color: var(--color-text-secondary, #737373); line-height: 1.35; }

/* Narrow-panel collapse: at < 720px the rail and reader stack;
   data-show toggles which one is visible. */
@media (max-width: 720px) {
  .two-pane { grid-template-columns: 1fr; }
  .two-pane[data-show="reader"] .rail { display: none; }
  .two-pane[data-show="rail"] .reader { display: none; }
  .reader-back { display: inline-flex !important; }
}
.reader-back {
  display: none; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: 1px solid var(--color-border-primary, #e5e5e5);
  border-radius: 50%; background: transparent; cursor: pointer;
  color: var(--color-text-secondary, #737373);
  margin-right: 8px; flex-shrink: 0;
}
.reader-back:hover { border-color: var(--color-text-accent, #0055FF); color: var(--color-text-accent, #0055FF); }

/* ============================================================
   Mobile responsiveness — defensive overflow guards + sized
   touch targets + content-aware stacking. Preserves the desktop
   variant-3 design; only kicks in at narrow widths.
   ============================================================ */

/* Defensive min-width: 0 so grid/flex children can actually shrink
   below their content's intrinsic min size. Without these, a wide
   skeleton card can push the rail past the viewport. */
.app { min-width: 0; }
.rail { min-width: 0; }
.reader { min-width: 0; }
.header-top > div { min-width: 0; }
.header-lede { overflow-wrap: anywhere; }
.detail-name { word-break: break-word; }

@media (max-width: 720px) {
  /* Header gets a tighter padding + larger create-btn for touch. */
  .header { padding: 16px 16px 10px; }

  /* Reader head stacks vertically so meta + actions don't fight. */
  .reader-head {
    flex-direction: column;
    align-items: stretch;
    padding: 14px 16px 12px;
  }
  .reader-head-meta { width: 100%; }
  .reader-head-title { gap: 6px; font-size: 12px; }
  .reader-head-sub { font-size: 11px; line-height: 1.5; }
  .reader-actions { justify-content: flex-start; gap: 8px; }
  .reader-body { padding: 16px 16px 24px; }

  /* When the back button is shown, place it inline with the head. */
  .reader-head { flex-direction: row; flex-wrap: wrap; }
  .reader-head .reader-head-meta { flex: 1; min-width: 0; }
  .reader-head .reader-actions { width: 100%; }

  /* Touch-friendly action buttons (scoped to action toolbars only —
     dense rail/run rows keep their compact size). */
  .reader-actions .btn,
  .detail-actions .btn {
    padding: 8px 14px;
    font-size: 12px;
    min-height: 36px;
  }
  .detail-actions { flex-wrap: wrap; gap: 8px; }

  /* Header back / detail back bumped to 36×36. */
  .back-btn { width: 36px; height: 36px; }

  /* Run rows get a bit more padding to land taps reliably. */
  .run-row { padding: 10px 12px; }

  /* Drop nested-scroll on the prompt at narrow widths — fights page scroll. */
  .detail-prompt { max-height: none; }
}

@media (max-width: 480px) {
  .header-title { font-size: 19px; }
  .header-lede { font-size: 13px; }
  .create-btn { padding: 8px 14px; font-size: 13px; }
  .create-btn svg { width: 16px; height: 16px; }

  /* Advanced config grid → single column. Side-by-side is unreadable
     in ~167px cells. */
  .detail-config-grid { grid-template-columns: 1fr; }
}
`;
