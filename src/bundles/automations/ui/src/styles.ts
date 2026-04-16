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
`;
