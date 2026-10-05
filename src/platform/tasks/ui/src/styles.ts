export const STYLES = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { height: 100%; width: 100%; overflow: hidden; }
body {
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: var(--color-background-primary);
  -webkit-font-smoothing: antialiased;
}
.app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-border-primary); border-radius: 3px; }

@keyframes breathe { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.header {
  position: sticky; top: 0; z-index: 10;
  background: var(--color-background-primary);
  padding: 20px 20px 12px;
  flex-shrink: 0;
}
.header-top { display: flex; justify-content: space-between; align-items: center; }
.header-title {
  font-family: var(--nb-font-heading);
  font-size: 22px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.3;
}
.header-lede { font-size: 14px; color: var(--color-text-secondary); margin-top: 2px; }

.create-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border: 1px solid var(--color-text-accent);
  border-radius: 20px; background: transparent;
  color: var(--color-text-accent);
  font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: background 0.15s, color 0.15s; white-space: nowrap;
}
.create-btn:hover { background: var(--color-text-accent); color: var(--nb-color-accent-foreground); }
.create-btn svg { width: 14px; height: 14px; }

.content { flex: 1; overflow-y: auto; padding: 0 20px 20px; }

.section-header {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary); margin: 16px 0 8px;
}
.section-header:first-child { margin-top: 0; }

.auto-list { display: flex; flex-direction: column; gap: 8px; animation: fadeIn 0.2s ease; }

.auto-card {
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  background: var(--color-background-secondary);
  padding: 12px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
  cursor: pointer;
}
.auto-card:hover {
  border-color: color-mix(in srgb, var(--color-text-accent) 40%, transparent);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.auto-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.auto-card-info { flex: 1; min-width: 0; }
.auto-card-name {
  font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px;
}
.auto-card-schedule { font-size: 12px; color: var(--color-text-secondary); margin-top: 2px; }
.auto-card-meta {
  display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px;
  font-size: 12px; color: var(--color-text-secondary);
}
.auto-card-meta span { display: inline-flex; align-items: center; gap: 4px; }
.auto-card-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: flex-start; }

.dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
/* Status dots take the injected status tokens. They are not decorative: the
   rail dots do carry a title naming the status, but a title on a span is
   unavailable on touch, invisible without hover and unreliable through screen
   readers, so it does not discharge the requirement — and the detail header's
   dot has none at all. Each therefore needs 3:1 against the ground per WCAG
   1.4.11. Dots render on three grounds: the page, the card, and the hover fill
   the rail and run rows paint over either of those. The hover fill is the
   tightest of the three and the one worth remembering when picking a value.

   That is the tokens at full opacity. Anything that fades a dot has to hold the
   bar on all three too — see dot-running below.

   timeout and backoff deliberately share one hue. They are warnings on
   different axes — a run that ran too long, and a task retrying after
   consecutive errors — and the token map has one warning for both. Rather than
   add a hue to the shell palette for one app, backoff carries its own
   backoff-badge with the retry count in words, so the states stay
   distinguishable without colour being the thing that separates them.
   That pairing holds on the card and in the status section, which gate the dot
   and the badge on the same condition, and the rail never renders backoff at
   all. It does NOT hold on the detail header, which renders the dot alone —
   there a backing-off and a timed-out task now look alike. 1.4.1 is still
   satisfied on that view because the status section below carries the badge,
   but the header dot on its own is weaker than it was.

   NOTE: this file is a JS template literal, so a backtick here terminates the
   stylesheet. Comments in it cannot use markdown code spans. */
.dot-success { background: var(--nb-color-success); }
.dot-failure { background: var(--nb-color-danger); }
.dot-timeout { background: var(--nb-color-warning); }
.dot-degraded { background: var(--nb-color-warning); }
.dot-disabled { background: var(--color-text-tertiary); }
.dot-backoff { background: var(--nb-color-warning); }
/* The running dot pulses on its OWN keyframe, not the shared breathe.
   breathe runs 0.3 -> 0.6 -> 0.3 and never reaches full opacity, which is fine
   for the skeleton it was written for but would cap this dot at 2.78:1 light /
   2.92:1 dark — under the 3:1 the dot needs, at every frame of the cycle. A
   token that clears the bar does not survive being faded to 60% of it.
   So the peak here is the token itself, and the trough is set high enough that
   the faded frame still clears the bar on every ground. The margin is thin, so
   do not lower it by eye: test/unit/platform/animated-dot-contrast.test.ts reads
   this keyframe and reports the real number on each ground when it fails.
   The conversations app's live dot has the same silhouette — full opacity at
   the extremes, motion in the middle — but it is not precedent for the value:
   it troughs at 0.4, which is 1.93:1 on the same token. Borrow the shape from
   it, not the number. */
@keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; transform: scale(0.85); } }
.dot-running { background: var(--color-text-accent); animation: dot-pulse 1.5s ease-in-out infinite; }
.dot-skipped { background: var(--color-text-tertiary); }

/* color-mix() is safe in an app stylesheet: no app runs Tailwind, so
   nothing rewrites this CSS into a first-operand fallback. That fallback is why
   the shell uses explicit alpha tokens instead. */
.backoff-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 500; color: var(--nb-color-warning);
  background: color-mix(in srgb, var(--nb-color-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-warning) 25%, transparent);
  border-radius: 12px; padding: 2px 8px;
}

.btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--color-border-primary);
  border-radius: 14px; background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s; white-space: nowrap;
}
.btn:hover { border-color: var(--color-text-accent); color: var(--color-text-accent); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-danger {
  border-color: color-mix(in srgb, var(--nb-color-danger) 40%, transparent);
  color: var(--nb-color-danger);
}
.btn-danger:hover { background: var(--nb-color-danger); color: var(--nb-color-danger-foreground); border-color: var(--nb-color-danger); }

.run-list { display: flex; flex-direction: column; gap: 4px; animation: fadeIn 0.2s ease; }
.run-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: var(--border-radius-sm);
  font-size: 13px; transition: background 0.1s; cursor: pointer;
}
.run-row:hover { background: color-mix(in srgb, var(--color-border-primary) 30%, transparent); }
.run-name { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-time { font-size: 12px; color: var(--color-text-secondary); flex-shrink: 0; }
.run-duration { font-size: 12px; color: var(--color-text-secondary); flex-shrink: 0; min-width: 48px; text-align: right; }

.run-expanded {
  padding: 8px 12px 12px 30px;
  font-size: 12px; color: var(--color-text-secondary);
  animation: fadeIn 0.15s ease;
}
.run-expanded pre {
  background: var(--color-background-primary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
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

.empty-state { text-align: center; padding: 64px 24px; color: var(--color-text-secondary); }
.empty-state-icon { margin-bottom: 12px; }
.empty-state-title {
  font-family: var(--nb-font-heading);
  font-size: 16px; font-weight: 500; letter-spacing: -0.025em; margin-bottom: 6px;
}
.empty-state-desc { font-size: 13px; line-height: 1.5; }

.skel {
  background: var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  animation: breathe 3s ease-in-out infinite;
}
.skel-card { height: 72px; }
.skel-row { height: 36px; }
.loading-list { display: flex; flex-direction: column; gap: 8px; }

.error-banner {
  padding: 10px 14px; margin: 0 0 12px;
  background: color-mix(in srgb, var(--nb-color-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-danger) 25%, transparent);
  border-radius: var(--border-radius-sm);
  color: var(--nb-color-danger); font-size: 13px;
}

.confirm-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100;
  display: flex; align-items: center; justify-content: center; animation: fadeIn 0.15s ease;
}
.confirm-panel {
  background: var(--color-background-secondary);
  border-radius: var(--border-radius-sm);
  padding: 24px; max-width: 360px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15); animation: fadeIn 0.2s ease;
}
.confirm-title {
  font-family: var(--nb-font-heading);
  font-size: 16px; font-weight: 500; letter-spacing: -0.025em; margin-bottom: 8px;
}
.confirm-desc { font-size: 13px; color: var(--color-text-secondary); margin-bottom: 16px; line-height: 1.5; }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }

.detail-header {
  display: flex; align-items: center; gap: 12px; margin-bottom: 4px;
}
.back-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: 1px solid var(--color-border-primary);
  border-radius: 50%; background: transparent; cursor: pointer;
  color: var(--color-text-secondary);
  transition: border-color 0.15s, color 0.15s;
  flex-shrink: 0;
}
.back-btn:hover { border-color: var(--color-text-accent); color: var(--color-text-accent); }

.detail-name {
  font-family: var(--nb-font-heading);
  font-size: 20px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.3;
  flex: 1; min-width: 0;
}
.detail-desc {
  font-size: 13px; color: var(--color-text-secondary);
  margin-bottom: 12px; line-height: 1.5;
}

.detail-section {
  margin-top: 16px;
}
.detail-section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary); margin-bottom: 8px;
}

.detail-prompt {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  padding: 12px 14px;
  font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  max-height: 240px; overflow-y: auto;
  cursor: pointer; position: relative;
}
.detail-prompt:hover {
  border-color: color-mix(in srgb, var(--color-text-accent) 40%, transparent);
}
.detail-prompt-hint {
  position: absolute; top: 8px; right: 10px;
  font-size: 10px; color: var(--color-text-secondary);
  font-family: var(--font-sans);
  opacity: 0; transition: opacity 0.15s;
}
.detail-prompt:hover .detail-prompt-hint { opacity: 1; }

.detail-config-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.detail-config-item {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  padding: 8px 12px; cursor: pointer;
  transition: border-color 0.15s;
}
.detail-config-item:hover {
  border-color: color-mix(in srgb, var(--color-text-accent) 40%, transparent);
}
.detail-config-label {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  color: var(--color-text-secondary); margin-bottom: 2px;
}
.detail-config-value {
  font-size: 13px; font-weight: 500; word-break: break-word;
}
.detail-config-value.muted { color: var(--color-text-secondary); font-weight: 400; font-style: italic; }

.detail-status-row {
  display: flex; gap: 16px; flex-wrap: wrap;
  font-size: 12px; color: var(--color-text-secondary);
  padding: 8px 0;
}
.detail-status-row span { display: inline-flex; align-items: center; gap: 4px; }

.detail-actions {
  display: flex; gap: 8px; margin: 16px 0;
}

.inline-edit-textarea {
  width: 100%; min-height: 80px; padding: 12px 14px;
  border: 2px solid var(--color-text-accent);
  border-radius: var(--border-radius-sm);
  background: var(--color-background-secondary);
  color: var(--color-text-primary);
  font-size: 13px; line-height: 1.6;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  resize: vertical; outline: none;
}
.inline-edit-input {
  width: 100%; padding: 4px 8px;
  border: 2px solid var(--color-text-accent);
  border-radius: 6px;
  background: var(--color-background-secondary);
  color: var(--color-text-primary);
  font-size: 13px; font-family: inherit;
  outline: none;
}
.inline-edit-textarea:focus-visible,
.inline-edit-input:focus-visible {
  outline: 2px solid var(--color-text-accent);
  outline-offset: 2px;
}
.inline-edit-actions {
  display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;
}

.chevron {
  display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
  transition: transform 0.15s;
}
.chevron.open { transform: rotate(90deg); }

/* Right pane — reader */
.reader { overflow-y: auto; background: var(--color-background-secondary); }

.reader-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; padding: 48px 32px; text-align: center; color: var(--color-text-secondary);
}
.reader-empty-title {
  font-family: var(--nb-font-heading);
  font-size: 17px; font-weight: 500; letter-spacing: -0.02em;
  color: var(--color-text-primary); margin-bottom: 8px;
}
.reader-empty-desc { font-size: 13px; line-height: 1.5; max-width: 360px; }

.reader-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
  padding: 20px 28px 14px;
  border-bottom: 1px solid var(--color-border-primary);
  position: sticky; top: 0; background: var(--color-background-secondary); z-index: 5;
}
.reader-head-meta { min-width: 0; }
.reader-head-title { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--color-text-secondary); flex-wrap: wrap; }
.reader-head-name {
  background: none; border: none; padding: 0; font: inherit; cursor: pointer;
  color: var(--color-text-primary); font-weight: 600;
  border-bottom: 1px solid transparent; transition: border-color 0.15s;
}
.reader-head-name:hover:not(:disabled) { border-bottom-color: var(--color-text-accent); }
.reader-head-name:disabled { cursor: default; }
.reader-head-status { color: var(--color-text-secondary); }
.reader-head-sep, .reader-head-dot { color: var(--color-border-primary); margin: 0 2px; }
.reader-head-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 10px;
  background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent);
  color: var(--color-text-secondary); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.4px;
}
.reader-head-sub {
  font-size: 12px; color: var(--color-text-secondary);
  margin-top: 5px; line-height: 1.5;
}
.reader-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }

.reader-body { padding: 22px 28px 28px; }
.reader-truncation-note {
  margin-top: 20px; padding: 10px 14px;
  font-size: 12px; color: var(--color-text-secondary);
  background: var(--color-background-primary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
}
.reader-error-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--nb-color-danger); margin-bottom: 6px; }
.reader-error-body {
  background: color-mix(in srgb, var(--nb-color-danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-danger) 25%, transparent);
  border-radius: var(--border-radius-sm);
  padding: 10px 12px; font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  color: var(--nb-color-danger);
}
.run-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 600;
  white-space: nowrap; flex-shrink: 0;
}
.run-badge-success { color: var(--nb-color-success); background: color-mix(in srgb, var(--nb-color-success) 14%, transparent); }
.run-badge-warning { color: var(--nb-color-warning); background: color-mix(in srgb, var(--nb-color-warning) 14%, transparent); }
.run-badge-danger { color: var(--nb-color-danger); background: color-mix(in srgb, var(--nb-color-danger) 14%, transparent); }
.run-badge-muted { color: var(--color-text-secondary); background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent); }
.reader-assessment { margin-top: 22px; }
.reader-assessment-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.reader-assessment-item { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.reader-assessment-mark { width: 14px; flex-shrink: 0; font-weight: 600; }
.reader-assessment-mark.pass { color: var(--nb-color-success); }
.reader-assessment-mark.fail { color: var(--nb-color-danger); }
.reader-assessment-body { flex: 1; min-width: 0; }
.reader-assessment-meta { color: var(--color-text-secondary); font-size: 12px; }
.reader-assessment-note { color: var(--color-text-secondary); font-size: 12px; margin-top: 6px; }
.reader-assessment-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; font-size: 12px; }
.reader-section-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-text-secondary); margin-bottom: 6px; cursor: default;
}
.reader-files { margin-top: 22px; }
.reader-file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.reader-file {
  font-size: 13px; font-family: var(--font-mono);
  color: var(--color-text-primary);
}
.reader-activity { margin-top: 22px; }
.reader-activity > summary { cursor: pointer; }
.reader-activity-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.reader-activity-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.reader-activity-name { font-family: var(--font-mono); color: var(--color-text-primary); }
.reader-activity-ms { margin-left: auto; color: var(--color-text-secondary); font-size: 11px; }

.reader-footer-meta {
  display: flex; gap: 16px; flex-wrap: wrap; margin-top: 22px; padding-top: 12px;
  border-top: 1px solid var(--color-border-primary);
  font-size: 11px; color: var(--color-text-secondary);
}
.reader-footer-meta span { display: inline-flex; align-items: center; gap: 4px; }

/* Rendered markdown */
.out-md {
  font-size: 14px; line-height: 1.65;
  color: var(--color-text-primary);
  max-width: 680px;
}
.out-md h1, .out-md h2, .out-md h3 {
  font-family: var(--nb-font-heading);
  font-weight: 500; letter-spacing: -0.02em;
}
.out-md h1 { font-size: 22px; margin: 0 0 6px; }
.out-md h2 { font-size: 16px; margin: 22px 0 7px; }
.out-md h3 { font-size: 14.5px; margin: 18px 0 5px; }
.out-md p { margin: 0 0 10px; }
.out-md ul, .out-md ol { margin: 0 0 12px 22px; }
.out-md li { margin-bottom: 4px; }
.out-md li > p { margin: 0; }
.out-md a { color: var(--color-text-accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--color-text-accent) 35%, transparent); }
.out-md a:hover { border-bottom-color: var(--color-text-accent); }
.out-md code {
  background: var(--color-background-primary);
  border: 1px solid var(--color-border-primary);
  border-radius: 4px; padding: 1px 5px;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  font-size: 12.5px;
}
.out-md pre {
  background: var(--color-background-primary);
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  padding: 12px 14px; margin: 10px 0;
  overflow-x: auto; font-size: 12.5px; line-height: 1.5;
}
.out-md pre code { background: none; border: none; padding: 0; }
.out-md blockquote {
  margin: 10px 0; padding: 6px 14px;
  border-left: 3px solid var(--color-border-primary);
  color: var(--color-text-secondary);
}
.out-md hr { border: none; border-top: 1px solid var(--color-border-primary); margin: 18px 0; }
.out-md table { border-collapse: collapse; margin: 10px 0; }
.out-md th, .out-md td { border: 1px solid var(--color-border-primary); padding: 6px 10px; font-size: 13px; text-align: left; }
.out-md th { background: var(--color-background-primary); font-weight: 600; }
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
  border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm);
  background: var(--color-background-secondary);
  color: var(--color-text-primary);
  font-family: inherit; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.template-card:hover { border-color: var(--color-text-accent); }
.template-card.dashed { border-style: dashed; }
.template-card-name { font-size: 13px; font-weight: 500; }
.template-card-desc { font-size: 11px; color: var(--color-text-secondary); line-height: 1.35; }

/* At narrow widths the batch pane shows its back control. */
@media (max-width: 720px) {
  .reader-back { display: inline-flex !important; }
}
.reader-back {
  display: none; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: 1px solid var(--color-border-primary);
  border-radius: 50%; background: transparent; cursor: pointer;
  color: var(--color-text-secondary);
  margin-right: 8px; flex-shrink: 0;
}
.reader-back:hover { border-color: var(--color-text-accent); color: var(--color-text-accent); }

/* ============================================================
   Mobile responsiveness — defensive overflow guards + sized
   touch targets + content-aware stacking. Preserves the desktop
   variant-3 design; only kicks in at narrow widths.
   ============================================================ */

/* Defensive min-width: 0 so grid/flex children can actually shrink
   below their content's intrinsic min size. Without these, a wide
   skeleton card can push a column past the viewport. */
.app { min-width: 0; }
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

/* ============================================================
   Views: the switcher, Saved, Upcoming, Activity, the result
   screen, the editor, dialogs. Every colour is a host token.
   Layout follows the panel's own width (container queries), not
   the viewport: the panel shrinks when the chat docks beside it.
   ============================================================ */
.app { container-type: inline-size; container-name: panel; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mono { font-family: var(--font-mono); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted-text { color: var(--color-text-secondary); font-size: 13px; }
:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 2px; }

.view-tabs { display: flex; gap: 2px; margin-top: 14px; border-bottom: 1px solid var(--color-border-primary); }
.view-tab {
  background: none; border: none; font: inherit; font-size: 13px; font-weight: 500;
  color: var(--color-text-secondary); padding: 8px 12px 9px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.view-tab:hover { color: var(--color-text-primary); }
.view-tab.on { color: var(--color-text-primary); border-bottom-color: var(--color-text-accent); }
.view-panel { padding: 0; }
.view-pad { padding: 16px 20px 24px; }
.view-h {
  font-family: var(--nb-font-heading); font-size: 15px; font-weight: 500;
  letter-spacing: -0.01em; margin: 18px 0 8px; display: flex; gap: 10px; align-items: baseline;
}
.view-h:first-child { margin-top: 0; }
.view-h-count { font-family: var(--font-sans); font-size: 12px; font-weight: 400; color: var(--color-text-secondary); }
.empty-block { padding: 40px 8px; max-width: 520px; }
.empty-block .empty-state-title { color: var(--color-text-primary); }
.empty-block .empty-state-desc { color: var(--color-text-secondary); margin-bottom: 14px; }
.note-banner {
  padding: 9px 12px; margin: 0 0 12px; font-size: 13px;
  background: color-mix(in srgb, var(--nb-color-warning) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--nb-color-warning) 25%, transparent);
  border-radius: var(--border-radius-sm); color: var(--color-text-primary);
}
.toast {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 50;
  background: var(--color-background-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md);
  padding: 8px 14px; font-size: 13px; box-shadow: var(--shadow-md); max-width: calc(100% - 32px);
}
.btn-accent { border-color: var(--color-text-accent); color: var(--color-text-accent); }
.btn-accent:hover { background: var(--color-text-accent); color: var(--nb-color-accent-foreground); }
.btn-icon { padding: 4px 9px; font-size: 14px; line-height: 1; }
.link-btn {
  background: none; border: none; padding: 0; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--color-text-accent); text-decoration: underline; text-underline-offset: 2px;
}
.link-btn.danger { color: var(--nb-color-danger); }
.task-link {
  background: none; border: none; padding: 0; font: inherit; font-weight: 500; cursor: pointer;
  color: var(--color-text-primary); text-align: left;
}
.task-link:hover { color: var(--color-text-accent); }
.cell-sub { display: block; font-size: 12px; color: var(--color-text-secondary); margin-top: 1px; }
.state-pill {
  display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 600; padding: 1px 6px;
  border-radius: 10px; color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent);
}
.state-pill.warn { color: var(--nb-color-warning); background: color-mix(in srgb, var(--nb-color-warning) 14%, transparent); }
.skel-inline { display: inline-block; width: 44px; height: 12px; }
.run-badge-active { color: var(--color-text-accent); background: color-mix(in srgb, var(--color-text-accent) 12%, transparent); }

/* Saved */
.saved-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.saved-table th {
  text-align: left; font-size: 12px; font-weight: 500; color: var(--color-text-secondary);
  padding: 6px 8px; border-bottom: 1px solid var(--color-border-primary);
}
.saved-table td { padding: 10px 8px; border-bottom: 1px solid var(--color-border-secondary); vertical-align: top; }
.saved-table tbody tr:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.last-run { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; background: none; border: none; padding: 0; cursor: pointer; font: inherit; }
.row-actions { white-space: nowrap; text-align: right; }
.row-actions > * { vertical-align: middle; }
.row-actions .btn { margin-right: 4px; }
.row-menu { position: relative; display: inline-block; }
.row-menu-list {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 170px;
  background: var(--color-background-secondary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-md); box-shadow: var(--shadow-md); padding: 4px;
  display: flex; flex-direction: column;
}
.row-menu-item {
  background: none; border: none; font: inherit; font-size: 13px; text-align: left; cursor: pointer;
  padding: 7px 10px; border-radius: var(--border-radius-sm); color: var(--color-text-primary);
}
.row-menu-item:hover, .row-menu-item:focus-visible { background: var(--color-background-tertiary); }
.row-menu-item.danger { color: var(--nb-color-danger); }
@container panel (max-width: 640px) {
  .saved-table thead { display: none; }
  .saved-table, .saved-table tbody, .saved-table tr, .saved-table td { display: block; width: 100%; }
  .saved-table tr { border-bottom: 1px solid var(--color-border-primary); padding: 8px 0; }
  .saved-table td { border: none; padding: 3px 0; text-align: left; }
  .saved-table td[data-label]:not([data-label="Task"])::before {
    content: attr(data-label) ": "; color: var(--color-text-secondary); font-size: 12px;
  }
  .saved-table td.num { text-align: left; }
  .row-actions { text-align: left; padding-top: 6px; }
  .view-pad { padding: 12px 14px 20px; }
}

/* Upcoming */
.up-list { list-style: none; display: flex; flex-direction: column; }
.up-row {
  display: grid; grid-template-columns: 150px minmax(0, 1fr) auto auto; gap: 12px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px solid var(--color-border-secondary); font-size: 13px;
}
.up-when { color: var(--color-text-primary); font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 6px; }
.up-what { min-width: 0; overflow-wrap: anywhere; }
.up-meta { color: var(--color-text-secondary); font-size: 12px; }
@container panel (max-width: 560px) {
  .up-row { grid-template-columns: minmax(0, 1fr) auto; }
  .up-meta { grid-column: 1 / -1; }
}

/* Activity */
fieldset.filter-bar, fieldset.builder-row { border: none; min-width: 0; }
fieldset.builder-row { border-bottom: 1px dashed var(--color-border-secondary); }
.filter-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-bottom: 12px; }
.filter-bar label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); }
.filter-bar select {
  font: inherit; font-size: 12px; color: var(--color-text-primary); background: var(--color-background-secondary);
  border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); padding: 3px 6px;
}
.act-list { list-style: none; }
.act-row { border-bottom: 1px solid var(--color-border-secondary); }
.act-main {
  width: 100%; display: grid; grid-template-columns: 112px minmax(0, 1fr) 84px 64px 60px 52px;
  gap: 10px; align-items: baseline; padding: 9px 4px; background: none; border: none;
  font: inherit; font-size: 13px; color: var(--color-text-primary); text-align: left; cursor: pointer;
}
.act-main:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.act-task { min-width: 0; overflow-wrap: anywhere; }
.act-note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act-by, .act-when, .act-dur { color: var(--color-text-secondary); font-size: 12px; }
.act-batch .act-label { font-weight: 600; font-size: 12px; }
.chev { display: inline-block; transition: transform 0.15s; }
.chev.open { transform: rotate(90deg); }
.act-expand { padding: 4px 4px 14px 16px; }
.act-expand .btn { margin-top: 8px; }
.load-more { margin-top: 14px; }
@container panel (max-width: 600px) {
  .act-main { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
  .act-label { grid-column: 1 / -1; }
  .act-by, .act-dur { display: none; }
}

/* Screens over the views */
.screen-head {
  display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border-primary); background: var(--color-background-primary);
  flex-shrink: 0;
}
.screen-head .back-btn { font-size: 15px; }
.screen-head-meta { flex: 1; min-width: 0; }
.screen-title {
  font-family: var(--nb-font-heading); font-size: 19px; font-weight: 500; letter-spacing: -0.02em;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; line-height: 1.3; flex: 1; min-width: 0;
}
.screen-sub { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--color-text-secondary); margin-top: 4px; }
.screen-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
@container panel (max-width: 560px) {
  .screen-head { flex-wrap: wrap; padding: 12px 14px 10px; }
  .screen-actions { width: 100%; justify-content: flex-start; }
}
.batch-screen .reader { height: 100%; }
.batch-screen .reader-back { display: inline-flex; }
.batch-run-links { display: inline-flex; gap: 10px; }

/* Result */
.result-content { padding-top: 18px; max-width: 860px; }
.result-section { margin-bottom: 22px; }
.result-deliverable { padding-bottom: 18px; border-bottom: 1px solid var(--color-border-primary); }
.result-h {
  font-family: var(--nb-font-heading); font-size: 15px; font-weight: 500; letter-spacing: -0.01em;
  margin-bottom: 8px; display: flex; align-items: center; gap: 10px;
}
.result-h4 { font-size: 12px; font-weight: 600; color: var(--color-text-secondary); margin: 10px 0 4px; }
.result-details > summary { cursor: pointer; list-style-position: inside; }
.result-files ul { list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.result-links { display: flex; gap: 16px; flex-wrap: wrap; }
.result-open { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--color-text-secondary); padding: 24px 0; }
.json-block, .tool-io pre {
  background: var(--color-background-secondary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm); padding: 10px 12px; font-family: var(--font-mono);
  font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto;
}
.verdict { font-family: var(--font-sans); font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; }
.verdict-pass { color: var(--nb-color-success); background: color-mix(in srgb, var(--nb-color-success) 14%, transparent); }
.verdict-fail { color: var(--nb-color-danger); background: color-mix(in srgb, var(--nb-color-danger) 14%, transparent); }
.verdict-uncertain { color: var(--nb-color-warning); background: color-mix(in srgb, var(--nb-color-warning) 14%, transparent); }
.verdict-not_assessed { color: var(--color-text-secondary); background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent); }
.assess-reason { font-size: 13px; color: var(--nb-color-warning); margin-bottom: 6px; }
.criteria-results { list-style: none; display: flex; flex-direction: column; gap: 10px; margin: 10px 0; }
.criterion-result { display: flex; gap: 10px; align-items: flex-start; }
.mark { width: 18px; flex-shrink: 0; font-weight: 700; text-align: center; }
.mark.pass { color: var(--nb-color-success); }
.mark.fail { color: var(--nb-color-danger); }
.criterion-body { flex: 1; min-width: 0; }
.criterion-rule { font-size: 14px; }
.criterion-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--color-text-secondary); margin-top: 2px; }
.criterion-why { font-size: 13px; color: var(--color-text-secondary); margin-top: 3px; border-left: 2px solid var(--color-border-primary); padding-left: 8px; }
.human-verdict { font-size: 13px; margin: 8px 0; }
.verdict-form { margin-top: 12px; max-width: 560px; }
.verdict-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.tool-calls { list-style: none; margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.tool-call > summary { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; padding: 3px 0; }
.tool-name { font-family: var(--font-mono); font-size: 12.5px; }
.tool-failed { font-size: 11px; color: var(--nb-color-danger); }
.tool-ms { margin-left: auto; font-size: 11px; color: var(--color-text-secondary); }
.tool-io { padding: 4px 0 10px 16px; }

/* Structured deliverable */
.sv-dl { display: grid; grid-template-columns: minmax(110px, max-content) minmax(0, 1fr); gap: 6px 18px; font-size: 14px; }
.sv-pair { display: contents; }
.sv-dl dt { color: var(--color-text-secondary); font-size: 13px; }
.sv-dl dd { min-width: 0; overflow-wrap: anywhere; }
.sv-dl-nested { font-size: 13px; gap: 3px 12px; }
.sv-null { color: var(--color-text-tertiary); }
.sv-list { margin-left: 18px; }
.sv-table-wrap { overflow-x: auto; max-width: 100%; }
.sv-table { border-collapse: collapse; font-size: 13px; }
.sv-table th { text-align: left; font-weight: 500; color: var(--color-text-secondary); padding: 4px 10px 4px 0; border-bottom: 1px solid var(--color-border-primary); }
.sv-table td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--color-border-secondary); vertical-align: top; }
.sv-dl a, .sv-table a, .sv-list a { color: var(--color-text-accent); overflow-wrap: anywhere; }
@container panel (max-width: 480px) {
  .sv-dl { grid-template-columns: 1fr; gap: 1px; }
  .sv-dl dd { margin-bottom: 6px; }
}

/* Forms */
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; min-width: 0; flex: 1; border: none; }
.field-grow { flex: 2; }
.field-label { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
.req { font-weight: 400; }
.field-row { display: flex; gap: 12px; flex-wrap: wrap; }
.field-row > .field { min-width: 140px; }
.field-error { font-size: 12px; color: var(--nb-color-danger); }
.hint { font-size: 12px; color: var(--color-text-secondary); line-height: 1.45; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; margin-bottom: 8px; }
.inline-edit-input:disabled { opacity: 0.6; }
.file-pick { position: relative; overflow: hidden; display: inline-block; }
.file-pick input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.input-form .link-btn, .field .link-btn { align-self: flex-start; }

/* Editor */
.editor { padding-bottom: 32px; max-width: 820px; }
.editor-section { padding: 18px 0 8px; border-bottom: 1px solid var(--color-border-primary); }
.editor-h { font-family: var(--nb-font-heading); font-size: 16px; font-weight: 500; letter-spacing: -0.015em; margin-bottom: 10px; }
.editor-h3 { font-size: 13px; font-weight: 600; margin: 6px 0 8px; }
.editor-hint { margin: -4px 0 12px; max-width: 620px; }
.segmented { display: inline-flex; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 2px; margin-bottom: 12px; flex-wrap: wrap; }
.seg { position: relative; padding: 5px 12px; font-size: 13px; border-radius: var(--border-radius-sm); cursor: pointer; color: var(--color-text-secondary); }
.seg input { position: absolute; opacity: 0; pointer-events: none; }
.seg.on { background: var(--color-background-tertiary); color: var(--color-text-primary); font-weight: 500; }
.seg:has(input:focus-visible) { outline: 2px solid var(--color-ring-primary); outline-offset: 1px; }
.criteria-list { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.criterion-card { border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 12px; background: var(--color-background-secondary); }
.builder-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--color-border-secondary); }
.builder-row > .field { margin-bottom: 0; min-width: 110px; }
.builder-req { margin-bottom: 6px; }
.fields-builder > .btn { margin-top: 10px; margin-bottom: 6px; }
.test-result { margin-top: 16px; padding: 16px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
.editor-foot { flex-shrink: 0; border-top: 1px solid var(--color-border-primary); background: var(--color-background-primary); padding: 10px 20px; }
.editor-foot-actions { display: flex; justify-content: flex-end; gap: 8px; }
.problems { list-style: disc; margin: 0 0 8px 18px; font-size: 12px; color: var(--nb-color-danger); }

/* Dialogs */
.modal-wide { max-width: 560px; }
.confirm-panel { max-height: calc(100% - 32px); overflow-y: auto; }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.modal-x { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: var(--color-text-secondary); padding: 0 2px; }
.modal-x:hover { color: var(--color-text-primary); }
.confirm-actions { flex-wrap: wrap; align-items: center; }

/* Honour a reduced-motion preference for both looping animations in this file.
   The one-shot fadeIn entrances are not looping and are left alone.

   Placement is load-bearing: a media query adds no specificity, so this block
   and the rules it overrides are all (0,1,0) and the later in source order
   wins. An override above the rule it targets is inert while looking exactly
   like a working one. Last in the file satisfies that unconditionally, and
   test/unit/platform/animated-dot-contrast.test.ts enforces it. */
@media (prefers-reduced-motion: reduce) {
  .dot-running, .skel { animation: none; }
}

/* Batches */
.batch-progress { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--color-text-secondary) 15%, transparent); overflow: hidden; }
.batch-progress-fill { height: 100%; background: var(--color-text-accent); transition: width 0.3s; }
.batch-counts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 10px 0; font-size: 12px; color: var(--color-text-secondary); }
.batch-count-pass { color: var(--nb-color-success); }
.batch-count-fail { color: var(--nb-color-danger); }
.batch-count-uncertain { color: var(--nb-color-warning); }
.batch-note { font-size: 12px; color: var(--color-text-secondary); margin-bottom: 10px; }
.batch-filter { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); margin: 6px 0 10px; }
.batch-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.batch-table th { text-align: left; font-weight: 500; color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border-primary); padding: 4px 6px; }
.batch-table td { border-bottom: 1px solid color-mix(in srgb, var(--color-border-primary) 50%, transparent); padding: 5px 6px; vertical-align: top; color: var(--color-text-primary); max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.batch-input { font-family: var(--font-mono); white-space: nowrap; }
.batch-pending { color: var(--color-text-secondary); }
.batch-run-link { background: none; border: none; padding: 0; color: var(--color-text-accent); cursor: pointer; font-size: 12px; }
.batch-run-output { padding: 6px 0; }
.batch-run-id { font-size: 11px; color: var(--color-text-secondary); margin-bottom: 4px; }
.batch-run-error { color: var(--nb-color-danger); white-space: pre-wrap; }
`;
