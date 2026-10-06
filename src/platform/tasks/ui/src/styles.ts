/*
  The Tasks panel's stylesheet. Every colour, font and type size is a token the
  host injects into the frame (paletteToExtAppsTokens); nothing here is a hex
  value or an ad-hoc font size.

  Type has three levels and a muted variant:
  - page title: drawn by the host's top bar from the trail the panel sends;
    .page-title is the fallback for a host that shows no breadcrumb
  - section heading: .section-heading, the heading face at the base size
  - body: the sans face at the small size, set on body
  - muted: secondary colour at the extra-small size (.muted, .hint, labels)
  Monospace (--font-mono) is for code, JSON, schemas, CSV and tool payloads
  only, never for prompts, rules or deliverable prose.

  Spacing is one scale, declared on .app and used by every page:
  - --page-x: the page's side padding (20px, as the Files app; 14px narrow)
  - --page-top: above the page header (16px)
  - --head-gap: from the page header to its content (16px)
  - --section-gap: between sections of a page (28px)
  - --row-y: a list row's vertical padding (10px)
  - --stack: between items inside a section (8px)
  - --inline: between an icon and its label, and between inline items (6px)
  Layout is fluid: no page or section caps its width. Only long prose
  paragraphs are held to a readable measure (.prose, .out-md: 72ch; a long
  value in structured output: 76ch).

  Sections: every page is a header (.page-header) and a column of cards
  (.sections, --section-gap apart). A card (.card, the Section component) is
  the full content width, with one border, radius, padding (--card-pad) and
  background, a header row (.card-head: title left, its actions or a one-line
  summary right) and a body. Controls, tables and lists inside a card fill
  its width. A report card (.summary-strip, the SummaryStrip component) is a
  row of equal tiles that wraps on a narrow page; a tile with more to say
  opens one panel under the strip.

  Buttons have two sizes: .btn in page headers and forms, .btn-sm in rows.

  NOTE: this file is a JS template literal, so a backtick here terminates the
  stylesheet. Comments in it cannot use markdown code spans.
*/
export const STYLES = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { height: 100%; width: 100%; overflow: hidden; }
body {
  font-family: var(--font-sans);
  font-size: var(--font-text-sm-size);
  line-height: var(--font-text-sm-line-height);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-primary);
  background: var(--color-background-primary);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
code { font-family: var(--font-mono); font-size: var(--font-text-xs-size); }
:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-border-primary); border-radius: 3px; }

@keyframes breathe { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }

/* ---------- Type ---------- */
.page-title {
  font-family: var(--nb-font-heading);
  font-size: var(--font-heading-sm-size); line-height: var(--font-heading-sm-line-height);
  font-weight: var(--font-weight-medium); letter-spacing: -0.02em;
}
.section-heading {
  font-family: var(--nb-font-heading);
  font-size: var(--font-text-base-size); line-height: var(--font-text-base-line-height);
  font-weight: var(--font-weight-medium); letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
}
.sub-heading { font-size: var(--font-text-sm-size); font-weight: var(--font-weight-medium); margin: 12px 0 6px; }
.muted, .hint, .cell-sub, .field-label, .screen-sub, .figure-label, .filter-name {
  font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height);
  color: var(--color-text-secondary);
}
.cell-sub { display: block; margin-top: 2px; }
.hint { margin-top: 4px; }
.field-label { font-weight: var(--font-weight-medium); }
.mono, .code { font-family: var(--font-mono); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 72ch; }
.warn-text { color: var(--color-text-warning); font-size: var(--font-text-xs-size); }
.tag {
  font-size: var(--font-text-2xs-size); line-height: var(--font-text-2xs-line-height);
  padding: 1px 6px; border-radius: 10px; color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent);
}

/* ---------- Layout ---------- */
.app {
  height: 100%; display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; min-width: 0;
  container-type: inline-size; container-name: panel;
  --page-x: 20px; --page-top: 16px; --head-gap: 16px; --section-gap: 28px;
  --row-y: 10px; --stack: 8px; --inline: 6px; --card-pad: 16px;
}
@container panel (max-width: 560px) { .app > * { --page-x: 14px; --section-gap: 16px; --card-pad: 12px; } }
/* One scroll container per page: the page header scrolls with the content
   (the host's own top bar stays pinned and carries the breadcrumb). */
.content { flex: none; }
.view-pad, .page-body { padding: 0 var(--page-x) 32px; }
.section { margin-bottom: var(--section-gap); }
.section-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: var(--stack); }
.section-row .section-heading { margin-bottom: 0; }
.section-meta { display: inline-flex; align-items: center; gap: var(--inline); }
.section-action { margin-top: var(--stack); }
.plain-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.empty-block { padding: 32px 0; max-width: 520px; }
.empty-state-title {
  font-family: var(--nb-font-heading); font-size: var(--font-text-base-size);
  line-height: var(--font-text-base-line-height); font-weight: var(--font-weight-medium); margin-bottom: 6px;
}
.empty-state-desc { color: var(--color-text-secondary); margin-bottom: 14px; }

/* The page header: heading and status on the left, the page's actions on the right */
.page-header {
  display: flex; align-items: center; gap: 16px; flex-shrink: 0;
  padding: var(--page-top) var(--page-x) var(--head-gap);
  background: var(--color-background-primary);
}
.page-header-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.page-heading {
  font-family: var(--nb-font-heading);
  font-size: var(--font-heading-sm-size); line-height: var(--font-heading-sm-line-height);
  font-weight: var(--font-weight-medium); letter-spacing: -0.02em; overflow-wrap: anywhere;
}
.page-status {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height); color: var(--color-text-secondary);
}
.page-actions { display: flex; align-items: center; gap: var(--stack); flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.back-btn {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 28px; height: 28px; border: 1px solid var(--color-border-primary); border-radius: 50%;
  background: transparent; cursor: pointer; color: var(--color-text-secondary);
}
.back-btn:hover { border-color: var(--color-text-accent); color: var(--color-text-accent); }
@container panel (max-width: 560px) {
  .page-header { flex-wrap: wrap; }
  .page-actions { margin-left: auto; }
}

/* ---------- Controls ---------- */
.btn {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  padding: 4px 12px; min-height: 28px; border: 1px solid var(--color-border-primary); border-radius: 14px;
  background: transparent; color: var(--color-text-primary);
  font-size: var(--font-text-xs-size); font-weight: var(--font-weight-medium); cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.btn:hover { border-color: var(--color-text-accent); color: var(--color-text-accent); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary, .btn-accent { background: var(--color-text-accent); border-color: var(--color-text-accent); color: var(--color-text-inverse); }
.btn-primary:hover, .btn-accent:hover { color: var(--color-text-inverse); opacity: 0.9; }
.btn-danger { border-color: color-mix(in srgb, var(--color-text-danger) 40%, transparent); color: var(--color-text-danger); }
.btn-danger:hover { background: var(--color-text-danger); color: var(--color-text-inverse); border-color: var(--color-text-danger); }
.btn-icon { padding: 2px 10px; font-size: var(--font-text-sm-size); line-height: 1; }
.link-btn {
  background: none; border: none; padding: 0; cursor: pointer; font-size: inherit;
  color: var(--color-text-accent); text-decoration: underline; text-underline-offset: 2px;
}
.link-btn.danger { color: var(--color-text-danger); }
.task-link { background: none; border: none; padding: 0; font-weight: var(--font-weight-medium); cursor: pointer; text-align: left; }
.task-link:hover { color: var(--color-text-accent); }
.switch { display: inline-flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer; font-size: var(--font-text-xs-size); font-weight: var(--font-weight-medium); }
.switch-track { width: 30px; height: 18px; border-radius: 9px; background: var(--color-border-primary); position: relative; transition: background 0.15s; flex-shrink: 0; }
.switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--color-background-primary); box-shadow: var(--shadow-hairline); transition: left 0.15s; }
.switch.on .switch-track { background: var(--color-text-accent); }
.switch.on .switch-thumb { left: 14px; }
.switch:disabled { opacity: 0.5; cursor: not-allowed; }

/* Row menu: fixed to the viewport so no scroll container clips it */
.row-menu { display: inline-block; }
.row-menu-list {
  z-index: 60; min-width: 180px; padding: 4px; display: flex; flex-direction: column;
  background: var(--color-background-secondary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-md); box-shadow: var(--shadow-md);
}
.row-menu-item { background: none; border: none; text-align: left; cursor: pointer; padding: 7px 10px; border-radius: var(--border-radius-sm); }
.row-menu-item:hover, .row-menu-item:focus-visible { background: var(--color-background-tertiary); }
.row-menu-item.danger { color: var(--color-text-danger); }

/* Segmented choice */
.segmented { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 2px; margin-bottom: 12px; }
.segmented.small { margin-bottom: 0; }
.seg { position: relative; padding: 4px 12px; border-radius: var(--border-radius-sm); cursor: pointer; color: var(--color-text-secondary); }
.segmented.small .seg { font-size: var(--font-text-xs-size); padding: 2px 10px; }
.seg input { position: absolute; opacity: 0; pointer-events: none; }
.seg.on { background: var(--color-background-tertiary); color: var(--color-text-primary); font-weight: var(--font-weight-medium); }
.seg:has(input:focus-visible) { outline: 2px solid var(--color-ring-primary); outline-offset: 1px; }

/* ---------- Banners, notices, skeletons ---------- */
.error-banner, .note-banner { padding: 9px 12px; margin: 0 0 12px; border-radius: var(--border-radius-sm); }
.error-banner { color: var(--color-text-danger); background: color-mix(in srgb, var(--color-text-danger) 9%, transparent); border: 1px solid color-mix(in srgb, var(--color-text-danger) 25%, transparent); }
.note-banner { background: color-mix(in srgb, var(--color-text-warning) 9%, transparent); border: 1px solid color-mix(in srgb, var(--color-text-warning) 25%, transparent); }
.toast {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 50; max-width: calc(100% - 32px);
  background: var(--color-background-tertiary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-md); padding: 8px 14px; box-shadow: var(--shadow-md);
}
.skel { background: var(--color-border-primary); border-radius: var(--border-radius-sm); animation: breathe 3s ease-in-out infinite; }
.skel-card { height: 72px; }
.skel-row { height: 36px; }
.skel-inline { display: inline-block; width: 44px; height: 12px; }
.loading-list { display: flex; flex-direction: column; gap: 8px; }

/* ---------- Status dots and labels ---------- */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-success { background: var(--color-text-success); }
.dot-failure { background: var(--color-text-danger); }
/* The running dot pulses on its OWN keyframe, not the shared breathe, so it
   holds the 3:1 a status indicator needs at every frame on every ground.
   test/unit/platform/animated-dot-contrast.test.ts reads this keyframe; do not
   lower the trough by eye. */
@keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; transform: scale(0.85); } }
.dot-running { background: var(--color-text-accent); animation: dot-pulse 1.5s ease-in-out infinite; }
.run-badge {
  font-size: var(--font-text-2xs-size); line-height: var(--font-text-2xs-line-height);
  font-weight: var(--font-weight-semibold); padding: 1px 7px; border-radius: 10px; white-space: nowrap; flex-shrink: 0;
}
.run-badge-success { color: var(--color-text-success); background: color-mix(in srgb, var(--color-text-success) 14%, transparent); }
.run-badge-warning { color: var(--color-text-warning); background: color-mix(in srgb, var(--color-text-warning) 14%, transparent); }
.run-badge-danger { color: var(--color-text-danger); background: color-mix(in srgb, var(--color-text-danger) 14%, transparent); }
.run-badge-muted { color: var(--color-text-secondary); background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent); }
.run-badge-active { color: var(--color-text-accent); background: color-mix(in srgb, var(--color-text-accent) 12%, transparent); }
.state-pill { margin-left: 6px; font-size: var(--font-text-2xs-size); font-weight: var(--font-weight-semibold); padding: 1px 6px; border-radius: 10px; color: var(--color-text-secondary); background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent); }
.state-pill.warn { color: var(--color-text-warning); background: color-mix(in srgb, var(--color-text-warning) 14%, transparent); }

/* ---------- Saved ---------- */
.saved-table { width: 100%; border-collapse: collapse; }
.saved-table th { text-align: left; font-size: var(--font-text-xs-size); font-weight: var(--font-weight-medium); color: var(--color-text-secondary); padding: 6px 8px; border-bottom: 1px solid var(--color-border-primary); }
.saved-table td { padding: 10px 8px; border-bottom: 1px solid var(--color-border-secondary); vertical-align: top; }
.saved-table tbody tr:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.last-run { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; background: none; border: none; padding: 0; cursor: pointer; }
.row-actions { white-space: nowrap; text-align: right; }
.row-actions > * { vertical-align: middle; margin-left: 6px; }
.template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.template-card { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 10px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); background: var(--color-background-secondary); cursor: pointer; }
.template-card:hover { border-color: var(--color-text-accent); }
.template-card.dashed { border-style: dashed; }
.template-card-name { font-weight: var(--font-weight-medium); }
.template-card-desc { font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
@container panel (max-width: 640px) {
  .saved-table thead { display: none; }
  .saved-table, .saved-table tbody, .saved-table tr, .saved-table td { display: block; width: 100%; }
  .saved-table tr { border-bottom: 1px solid var(--color-border-primary); padding: 8px 0; position: relative; }
  .saved-table td { border: none; padding: 2px 0; text-align: left; }
  .saved-table td[data-label]:not([data-label="Task"])::before { content: attr(data-label) ": "; color: var(--color-text-secondary); font-size: var(--font-text-xs-size); }
  .saved-table td.num { text-align: left; }
  .saved-table td.row-actions { position: absolute; top: 8px; right: 0; width: auto; }
  .saved-table td[data-label="Task"] { padding-right: 48px; }
}

/* ---------- Task page ---------- */
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
.figure { border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 10px 12px; }
.figure-value { font-size: var(--font-text-base-size); line-height: var(--font-text-base-line-height); font-weight: var(--font-weight-medium); font-variant-numeric: tabular-nums; }
.run-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }
.run-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--color-border-primary); border-radius: 14px; background: none; cursor: pointer; }
.run-chip:hover { border-color: var(--color-text-accent); }
.definition .def-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.def-list { display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr); gap: 6px 18px; margin-top: 8px; }
.def-row { display: contents; }
.def-list dt { color: var(--color-text-secondary); }
.def-list dd { min-width: 0; overflow-wrap: anywhere; }
.criteria-read { margin: 0 0 8px 20px; display: flex; flex-direction: column; gap: 4px; }
.details > summary, .disclosure > summary, .raw > summary, .step-details > summary { cursor: pointer; list-style: none; display: flex; align-items: center; }
.details > summary::-webkit-details-marker, .disclosure > summary::-webkit-details-marker, .raw > summary::-webkit-details-marker, .step-details > summary::-webkit-details-marker { display: none; }
.details > summary::before, .disclosure > summary::before, .raw > summary::before, .step-details > summary::before {
  content: ""; width: 6px; height: 6px; margin-right: 4px; flex-shrink: 0;
  border-right: 1.5px solid var(--color-text-secondary); border-bottom: 1.5px solid var(--color-text-secondary);
  transform: rotate(-45deg); transition: transform 0.15s; display: inline-block;
}
.details[open] > summary::before, .disclosure[open] > summary::before, .raw[open] > summary::before, .step-details[open] > summary::before { transform: rotate(45deg); }
@container panel (max-width: 480px) {
  .def-list { grid-template-columns: 1fr; gap: 1px; }
  .def-list dd { margin-bottom: 6px; }
}

/* ---------- Upcoming ---------- */
.up-list { list-style: none; display: flex; flex-direction: column; margin-bottom: 8px; }
.up-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto auto; gap: 12px; align-items: baseline; padding: var(--row-y) 0; border-bottom: 1px solid var(--color-border-secondary); }
.up-row.beyond .up-when { color: var(--color-text-secondary); }
.up-when { font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 6px; }
.up-what { min-width: 0; overflow-wrap: anywhere; }
.up-meta { color: var(--color-text-secondary); font-size: var(--font-text-xs-size); }
@container panel (max-width: 560px) {
  .up-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
  .up-when { grid-column: 1; font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
  .up-what { grid-column: 1; justify-self: start; }
  .up-meta { grid-column: 1; }
  .up-row > .link-btn { grid-column: 2; grid-row: 1 / span 3; align-self: center; }
}

/* ---------- Activity ---------- */
fieldset.filter-bar { border: none; min-width: 0; }
.filter-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-bottom: 12px; }
.filter-bar label { display: inline-flex; align-items: center; gap: 6px; }
.filter-bar select { font-size: var(--font-text-xs-size); background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); padding: 3px 6px; }
.act-list { list-style: none; }
.act-row { border-bottom: 1px solid var(--color-border-secondary); }
.act-main { width: 100%; display: grid; grid-template-columns: 112px minmax(0, 1fr) 84px 64px 60px 52px; gap: 10px; align-items: baseline; padding: 9px 4px; background: none; border: none; text-align: left; cursor: pointer; }
.act-main:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.act-task { min-width: 0; overflow-wrap: anywhere; }
.act-note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act-by, .act-when, .act-dur, .act-cost { color: var(--color-text-secondary); font-size: var(--font-text-xs-size); }
.act-batch .act-label { font-weight: var(--font-weight-medium); }
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

/* ---------- Result ---------- */
.result-content { padding-top: 0; }
.result-files ul { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.result-links { display: flex; gap: 16px; flex-wrap: wrap; }
.result-open { display: flex; align-items: center; gap: 8px; color: var(--color-text-secondary); padding: 24px 0; }
.code-block, .tool-io pre {
  background: var(--color-background-secondary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-sm); padding: 10px 12px; font-family: var(--font-mono);
  font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-x: hidden; overflow-y: auto;
}
.assess-reason { color: var(--color-text-warning); margin-bottom: 6px; }
.criteria-results { list-style: none; display: flex; flex-direction: column; gap: 10px; margin: 10px 0; }
.criterion-result { display: flex; gap: 10px; align-items: flex-start; }
.mark { width: 18px; flex-shrink: 0; font-weight: var(--font-weight-bold); text-align: center; }
.mark.pass { color: var(--color-text-success); }
.mark.fail { color: var(--color-text-danger); }
.criterion-body { flex: 1; min-width: 0; }
.criterion-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--font-text-xs-size); color: var(--color-text-secondary); margin-top: 2px; }
.criterion-why { color: var(--color-text-secondary); margin-top: 3px; border-left: 2px solid var(--color-border-primary); padding-left: 8px; }
.human-verdict { margin: 8px 0; }
.verdict-form { margin-top: var(--card-pad); }
.verdict-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.tool-calls { list-style: none; margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.tool-call > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 3px 0; }
.tool-name { font-family: var(--font-mono); font-size: var(--font-text-xs-size); }
.tool-failed { font-size: var(--font-text-xs-size); color: var(--color-text-danger); }
.tool-ms { margin-left: auto; font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
.tool-io { padding: 4px 0 10px 16px; }

/* Structured deliverable */
.sv-dl { display: grid; grid-template-columns: minmax(110px, max-content) minmax(0, 1fr); gap: 6px 18px; }
.sv-pair { display: contents; }
.sv-dl dt { color: var(--color-text-secondary); }
.sv-dl dd { min-width: 0; max-width: 76ch; overflow-wrap: anywhere; }
.sv-dl-nested { gap: 3px 12px; }
.sv-null { color: var(--color-text-tertiary); }
.sv-list { margin-left: 18px; }
.sv-table-wrap { max-width: 100%; }
.sv-table { width: 100%; }
.sv-table td, .sv-table th { overflow-wrap: anywhere; }
.sv-table { border-collapse: collapse; }
.sv-table th { text-align: left; font-weight: var(--font-weight-medium); color: var(--color-text-secondary); padding: 4px 12px 4px 0; border-bottom: 1px solid var(--color-border-primary); }
.sv-table td { padding: 5px 12px 5px 0; border-bottom: 1px solid var(--color-border-secondary); vertical-align: top; }
.sv-dl a, .sv-table a, .sv-list a { color: var(--color-text-accent); overflow-wrap: anywhere; }
@container panel (max-width: 480px) {
  .sv-dl { grid-template-columns: 1fr; gap: 1px; }
  .sv-dl dd { margin-bottom: 6px; }
}

/* Rendered markdown deliverable: prose in the body face; code in mono */
.out-md { max-width: 72ch; overflow-wrap: anywhere; }
.out-md h1, .out-md h2, .out-md h3 {
  font-family: var(--nb-font-heading); font-weight: var(--font-weight-medium);
  font-size: var(--font-text-base-size); line-height: var(--font-text-base-line-height); margin: 16px 0 6px;
}
.out-md h1:first-child, .out-md h2:first-child, .out-md h3:first-child { margin-top: 0; }
.out-md p { margin: 0 0 10px; }
.out-md ul, .out-md ol { margin: 0 0 12px 22px; }
.out-md li { margin-bottom: 4px; }
.out-md li > p { margin: 0; }
.out-md a { color: var(--color-text-accent); }
.out-md code { background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: 4px; padding: 1px 5px; }
.out-md pre { background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); padding: 10px 12px; margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.out-md pre code { background: none; border: none; padding: 0; }
.out-md blockquote { margin: 10px 0; padding: 4px 12px; border-left: 3px solid var(--color-border-primary); color: var(--color-text-secondary); }
.out-md hr { border: none; border-top: 1px solid var(--color-border-primary); margin: 16px 0; }
.out-md table { border-collapse: collapse; margin: 10px 0; }
.out-md th, .out-md td { border: 1px solid var(--color-border-primary); padding: 5px 10px; text-align: left; }
.out-md th { font-weight: var(--font-weight-medium); }
.out-md strong { font-weight: var(--font-weight-semibold); }

/* ---------- Batches ---------- */
.reader { display: flex; flex-direction: column; }
.reader-error-body { color: var(--color-text-danger); background: color-mix(in srgb, var(--color-text-danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--color-text-danger) 25%, transparent); border-radius: var(--border-radius-sm); padding: 10px 12px; font-family: var(--font-mono); font-size: var(--font-text-xs-size); white-space: pre-wrap; word-break: break-word; }
.batch-progress { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--color-text-secondary) 15%, transparent); overflow: hidden; }
.batch-progress-fill { height: 100%; background: var(--color-text-accent); transition: width 0.3s; }
.batch-counts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 10px 0; font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
.batch-count-pass { color: var(--color-text-success); }
.batch-count-fail { color: var(--color-text-danger); }
.batch-count-uncertain { color: var(--color-text-warning); }
.batch-note { color: var(--color-text-secondary); margin-bottom: 10px; }
.batch-filter { display: flex; align-items: center; gap: var(--inline); color: var(--color-text-secondary); font-size: var(--font-text-xs-size); }
.batch-table { width: 100%; border-collapse: collapse; }
.batch-table th { text-align: left; font-size: var(--font-text-xs-size); font-weight: var(--font-weight-medium); color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border-primary); padding: 4px 6px; }
.batch-table td { border-bottom: 1px solid var(--color-border-secondary); padding: 5px 6px; vertical-align: top; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.batch-input { font-family: var(--font-mono); font-size: var(--font-text-xs-size); white-space: nowrap; }
.batch-pending { color: var(--color-text-secondary); }
.batch-run-links { display: inline-flex; gap: 10px; }
.batch-run-link { background: none; border: none; padding: 0; color: var(--color-text-accent); cursor: pointer; }
.batch-table td.batch-expand { max-width: none; overflow: visible; padding: var(--card-pad) 6px; background: var(--color-background-secondary); }
.batch-run-output { display: flex; flex-direction: column; gap: var(--stack); }
.batch-run-foot { display: flex; align-items: center; gap: 12px; }
.muted-link { color: var(--color-text-secondary); font-size: var(--font-text-xs-size); }
.batch-run-error { color: var(--color-text-danger); white-space: pre-wrap; }

/* ---------- Forms ---------- */
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; min-width: 0; flex: 1; border: none; }
.field-grow { flex: 2; }
.req { font-weight: var(--font-weight-normal); }
.field-row { display: flex; gap: 12px; flex-wrap: wrap; }
.field-row > .field { min-width: 140px; }
.field-error { font-size: var(--font-text-xs-size); color: var(--color-text-danger); }
.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 10px; }
.inline-edit-input, .inline-edit-textarea {
  width: 100%; padding: 6px 10px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm);
  background: var(--color-background-secondary); color: var(--color-text-primary); outline: none;
}
.inline-edit-input:focus, .inline-edit-textarea:focus { border-color: var(--color-text-accent); }
.inline-edit-textarea { min-height: 72px; resize: vertical; line-height: var(--font-text-sm-line-height); }
.inline-edit-textarea.code { font-family: var(--font-mono); font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height); }
.inline-edit-input:disabled { opacity: 0.6; }
.file-pick { position: relative; overflow: hidden; display: inline-block; }
.file-pick input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.input-form .link-btn, .field .link-btn { align-self: flex-start; }

/* Schedule picker */
.sched-picker { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
.sched-option { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 0; cursor: pointer; }
.sched-input { padding: 4px 8px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-sm); background: var(--color-background-secondary); }

/* Editor */
.editor .editor-section:first-child { padding-top: 0; }
.editor-section { padding: 20px 0 6px; margin: 0; border-bottom: 1px solid var(--color-border-primary); }
.editor-section:first-child { padding-top: 4px; }
.editor-section > .hint:first-of-type { margin: -4px 0 14px; max-width: 72ch; }
.criteria-list { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }
.criterion-card { border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 14px 14px 10px; background: var(--color-background-secondary); }
.criterion-card fieldset.field { padding: 0; }
.criterion-card legend { margin-bottom: 4px; }
fieldset.builder-row { border: none; min-width: 0; padding: 10px 0; border-bottom: 1px dashed var(--color-border-secondary); }
.builder-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.builder-row > .field { margin-bottom: 0; min-width: 110px; }
.builder-req { margin-bottom: 6px; }
.fields-builder > .btn, .criteria-editor > .btn { margin: 10px 0 12px; }
.test-result { margin-top: 16px; padding: 16px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
.problems { list-style: disc; margin: 0 0 8px 18px; font-size: var(--font-text-xs-size); color: var(--color-text-danger); }

/* ---------- Dialogs ---------- */
.confirm-overlay { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--color-text-primary) 30%, transparent); }
.confirm-panel { background: var(--color-background-primary); border-radius: var(--border-radius-md); padding: 20px; max-width: 380px; width: calc(100% - 32px); max-height: calc(100% - 32px); overflow-y: auto; box-shadow: var(--shadow-lg); }
.modal-wide { max-width: 560px; }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.confirm-title { font-family: var(--nb-font-heading); font-size: var(--font-text-base-size); line-height: var(--font-text-base-line-height); font-weight: var(--font-weight-medium); }
.confirm-desc { color: var(--color-text-secondary); margin-bottom: 16px; }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
.modal-x { background: none; border: none; font-size: var(--font-text-lg-size); line-height: 1; cursor: pointer; color: var(--color-text-secondary); padding: 0 2px; }
.modal-x:hover { color: var(--color-text-primary); }

/* ---------- Tone: status colour carried by a class, read as --tone ---------- */
.tone-success { --tone: var(--color-text-success); }
.tone-danger { --tone: var(--color-text-danger); }
.tone-warning { --tone: var(--color-text-warning); }
.tone-active { --tone: var(--nb-color-processing); }
.tone-muted { --tone: var(--color-text-secondary); }
.status-icon { width: 16px; height: 16px; flex-shrink: 0; color: var(--tone); }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 1.2s linear infinite; transform-origin: center; }
.btn-sm { min-height: 24px; padding: 2px 10px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 28px; height: 28px; border: none; border-radius: 50%; background: transparent;
  color: var(--color-text-secondary); font-size: var(--font-text-lg-size); line-height: 1; cursor: pointer;
}
.icon-btn:hover { background: var(--color-background-tertiary); color: var(--color-text-primary); }
.callout {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 16px;
  border-radius: var(--border-radius-md);
  background: color-mix(in srgb, var(--tone) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent);
}
.callout > span { flex: 1; min-width: 12ch; }
.status-badge {
  justify-self: start; align-self: center;
  display: inline-flex; align-items: center; gap: var(--inline); white-space: nowrap; flex-shrink: 0;
  font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height);
  font-weight: var(--font-weight-medium); color: var(--tone);
  padding: 2px 8px 2px 6px; border-radius: 12px;
  background: color-mix(in srgb, var(--tone) 12%, transparent);
}
.status-badge .status-icon { width: 14px; height: 14px; }

/* ---------- Home ---------- */
.home-foot { display: flex; }
.attn-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.attn-card {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--border-radius-md);
  border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent); border-left: 3px solid var(--tone);
  background: color-mix(in srgb, var(--tone) 6%, transparent);
}
.attn-icon { display: inline-flex; }
.attn-icon .status-icon { width: 20px; height: 20px; }
.attn-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.attn-name { background: none; border: none; padding: 0; text-align: left; cursor: pointer; font-weight: var(--font-weight-medium); }
.attn-name:hover { color: var(--color-text-accent); }
.attn-why { color: var(--color-text-secondary); }
.live-list { list-style: none; display: flex; flex-direction: column; gap: var(--stack); }
.live-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
.live-text { flex: 1; min-width: 0; }
.coming-strip { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--stack); }
.coming-slot {
  width: 100%; height: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  padding: 10px 12px; border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md);
  background: none; cursor: pointer;
}
.coming-slot:hover { border-color: var(--color-text-accent); }
.coming-slot > * { max-width: 100%; }
.coming-name { font-weight: var(--font-weight-medium); overflow-wrap: anywhere; }
.coming-sched { font-size: var(--font-text-xs-size); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.coming-risk { color: var(--color-text-danger); font-size: var(--font-text-xs-size); }
.home-rows { list-style: none; }
.home-row {
  width: 100%; display: grid; grid-template-columns: 16px minmax(0, 1fr) minmax(0, auto) minmax(0, auto);
  gap: 12px; align-items: center; padding: var(--row-y) 4px; border: none; border-bottom: 1px solid var(--color-border-secondary);
  background: none; text-align: left; cursor: pointer;
}
.home-row:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.home-row-name { font-weight: var(--font-weight-medium); min-width: 0; overflow-wrap: anywhere; }
.home-row-sched, .home-row-when { font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
.home-row-when { text-align: right; }
@container panel (max-width: 560px) {
  .home-row { grid-template-columns: 16px minmax(0, 1fr); row-gap: 2px; }
  .home-row-sched, .home-row-when { grid-column: 2; text-align: left; }
  .attn-card { flex-wrap: wrap; }
}

/* ---------- Task page ---------- */
.task-head { padding: 14px 20px 12px; border-bottom: 1px solid var(--color-border-primary); flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; background: var(--color-background-primary); }
.task-title-row { display: flex; align-items: center; gap: 12px; }
.task-title-row .page-title { overflow-wrap: anywhere; }
.task-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
.task-runs { list-style: none; display: flex; flex-direction: column; }
.task-run {
  width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: center;
  padding: var(--row-y) 4px; border: none; border-bottom: 1px solid var(--color-border-secondary); background: none; text-align: left; cursor: pointer;
}
.task-run-what { display: flex; align-items: center; gap: 10px; min-width: 0; }
.task-run-input { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act-input { color: var(--color-text-secondary); }
.advanced { margin-top: var(--stack); border-top: 1px solid var(--color-border-primary); }
.task-run:hover { background: color-mix(in srgb, var(--color-border-primary) 22%, transparent); }
.latest-open { display: flex; align-items: center; gap: 10px; }
.result-preview { overflow-wrap: anywhere; }
.raw { margin-top: var(--stack); }
.raw > summary, .step-details > summary {
  width: fit-content; gap: var(--inline);
  font-size: var(--font-text-xs-size); color: var(--color-text-secondary);
}
.raw .code-block { margin-top: var(--stack); }
.task-runs + .link-btn, .home-rows + .link-btn { margin-top: var(--stack); }
.editor-problems { padding: 0 var(--page-x); flex-shrink: 0; }
.disclosure { border-top: 1px solid var(--color-border-secondary); }
.disclosure:first-child { border-top: none; }
.disclosure > summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: var(--row-y) 0; }
.setup .disclosure:first-child > summary { padding-top: 0; }
.disclosure-title { font-weight: var(--font-weight-medium); }
.disclosure-hint { font-size: var(--font-text-xs-size); color: var(--color-text-secondary); }
.disclosure-body { padding: 0 0 14px; }

/* ---------- Run steps ---------- */
.steps { list-style: none; display: flex; flex-direction: column; }
.step { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; position: relative; padding-bottom: 12px; }
.step:not(:last-child)::before {
  content: ""; position: absolute; left: 9px; top: 20px; bottom: 0; width: 2px;
  background: var(--color-border-primary);
}
.step-node { display: inline-flex; padding-top: 2px; }
.step-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.step-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.step-title { min-width: 0; overflow-wrap: anywhere; }
.step-title .tool-failed { margin-left: 6px; }
.step-time { font-size: var(--font-text-xs-size); color: var(--color-text-secondary); flex-shrink: 0; }
.step-bar { display: block; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent); overflow: hidden; }
.step-bar > span { display: block; height: 100%; background: color-mix(in srgb, var(--tone) 60%, transparent); }

/* ---------- Sections (cards) and the report card ---------- */
.sections { display: flex; flex-direction: column; gap: var(--section-gap); }
.sections > .callout, .sections > .error-banner, .sections > .note-banner, .sections > ul { margin: 0; }
.card {
  border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-lg);
  background: var(--color-background-primary); padding: var(--card-pad); min-width: 0;
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.card-head .section-heading { margin-bottom: 0; }
.card-aside { display: flex; align-items: center; gap: var(--stack); flex-wrap: wrap; justify-content: flex-end; }
.card-body > :last-child { margin-bottom: 0; }
.card-body .field:last-child { margin-bottom: 0; }
.summary { display: flex; flex-direction: column; gap: var(--stack); }
.summary-strip { list-style: none; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--stack); }
.tile-cell { display: flex; min-width: 0; }
.tile {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; text-align: left;
  border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-lg);
  background: var(--color-background-primary); padding: 12px 14px; position: relative;
}
button.tile { cursor: pointer; }
button.tile:hover, button.tile.on { border-color: var(--color-text-accent); }
.tile-label { font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height); color: var(--color-text-secondary); }
.tile-value { font-weight: var(--font-weight-medium); overflow-wrap: anywhere; }
.tile-sub { font-size: var(--font-text-xs-size); line-height: var(--font-text-xs-line-height); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.tile-more {
  position: absolute; top: 14px; right: 12px; width: 6px; height: 6px;
  border-right: 1.5px solid var(--color-text-secondary); border-bottom: 1.5px solid var(--color-text-secondary);
  transform: rotate(45deg); transition: transform 0.15s;
}
button.tile.on .tile-more { transform: rotate(-135deg); top: 17px; }
.tile-detail { border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-lg); padding: var(--card-pad); }
@container panel (max-width: 900px) { .summary-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container panel (max-width: 560px) { .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.data-table { width: 100%; border-collapse: collapse; }
.data-table th { text-align: left; font-size: var(--font-text-xs-size); font-weight: var(--font-weight-medium); color: var(--color-text-secondary); padding: 0 12px 6px 0; border-bottom: 1px solid var(--color-border-primary); }
.data-table td { padding: var(--row-y) 12px var(--row-y) 0; border-bottom: 1px solid var(--color-border-secondary); vertical-align: top; }
.data-table tr:last-child td { border-bottom: none; }
.card-body li:last-child > .task-run, .card-body li:last-child > .home-row, .card .up-row:last-child, .card .act-row:last-child { border-bottom: none; }
.data-table td:last-child, .data-table th:last-child { padding-right: 0; }

/* Honour a reduced-motion preference for the looping animations. Last in the
   file so it wins over the rules it overrides (equal specificity); the dot
   contrast test enforces the placement. */
@media (prefers-reduced-motion: reduce) {
  .dot-running, .skel, .spin { animation: none; }
}
`;
