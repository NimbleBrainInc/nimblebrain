import { renderFragment } from "../settings-types.ts";

const SYSTEM_SECTION_STYLES = `
	.page { max-width: 720px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 4px; }
	.subtitle { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 24px; }
	.version-badge { display: inline-block; font-family: monospace; font-size: 15px; font-weight: 600; color: var(--color-text-accent, #0055FF); background: rgba(0,85,255,.08); padding: 4px 12px; border-radius: var(--border-radius-sm, 0.5rem); margin-bottom: 24px; }
	table { width: 100%; border-collapse: collapse; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.75rem); overflow: hidden; }
	th { text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-background-primary, #faf9f7); border-bottom: 1px solid var(--color-border-primary, #e5e5e5); }
	td { padding: 8px 16px; font-size: 13px; color: var(--color-text-primary, #171717); border-bottom: 1px solid var(--color-background-tertiary, #f8f7f5); }
	td.pkg-name { font-weight: 500; }
	td.pkg-version { font-family: monospace; font-size: 12px; color: var(--color-text-secondary, #737373); }
	tr:last-child td { border-bottom: none; }
	.loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
	.error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
`;

const SYSTEM_SECTION_SCRIPT = `
	var app = document.getElementById("section-root") || document.getElementById("app");
	app.innerHTML = '<div class="loading">Loading version info\\u2026</div>';

	callTool("nb__version", {}).then(function(raw) {
		var data = parseResult(raw);
		if (!data) { app.innerHTML = '<div class="error">Failed to parse version data.</div>'; return; }

		var deps = data.dependencies || {};
		var keys = Object.keys(deps).sort();
		var rows = keys.map(function(k) {
			return '<tr><td class="pkg-name">' + k + '</td><td class="pkg-version">' + deps[k] + '</td></tr>';
		}).join("");

		app.innerHTML =
			'<div class="page">' +
			'<h1>System</h1>' +
			'<p class="subtitle">Platform version and dependency information.</p>' +
			'<div class="version-badge">' + (data.name || 'nimblebrain') + ' v' + (data.version || '?') + '</div>' +
			'<table><thead><tr><th>Package</th><th>Version</th></tr></thead>' +
			'<tbody>' + (rows || '<tr><td colspan="2">No dependencies found.</td></tr>') + '</tbody></table>' +
			'</div>';
	}).catch(function(err) {
		app.innerHTML = '<div class="error">Failed to load: ' + (err.message || err) + '</div>';
	});
`;

export function settingsSystemSection(): string {
  return renderFragment(SYSTEM_SECTION_STYLES, SYSTEM_SECTION_SCRIPT);
}
