import { renderFragment } from "../settings-types.ts";

const USAGE_SECTION_STYLES = `
	.page { max-width: 960px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 4px; }
	.subtitle { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 24px; }
	.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
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
	.loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
	.error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
`;

const USAGE_SECTION_SCRIPT = `
	var usageContainer = document.getElementById("section-root") || document.getElementById("app");

	function renderUsage(data) {
		var totals = data.totals || {};
		var tokens = totals.tokens || {};
		var cost = totals.cost || {};
		var breakdown = data.breakdown || [];
		var rows = breakdown.map(function(d) {
			var dt = d.tokens || {};
			var dc = d.cost || {};
			return '<tr><td>' + (d.key || '\\u2014') + '</td>'
				+ '<td>' + ((dt.input || 0) + (dt.output || 0)).toLocaleString() + '</td>'
				+ '<td>$' + (dc.total || 0).toFixed(4) + '</td>'
				+ '<td>' + (d.llmCalls || 0) + '</td></tr>';
		}).join("") || '<tr><td colspan="4" class="empty">No data for this period</td></tr>';

		usageContainer.innerHTML =
			'<div class="page">' +
			'<div class="header"><div><h1>Usage</h1><p class="subtitle">Token usage, cost, and request breakdown.</p></div>' +
			'<select id="period">' +
			'<option value="day">Today</option>' +
			'<option value="week" selected>Last 7 days</option>' +
			'<option value="month">This month</option>' +
			'<option value="all">All time</option>' +
			'</select></div>' +
			'<div class="totals">' +
			'<div class="stat"><div class="stat-value">' + ((tokens.input || 0) + (tokens.output || 0)).toLocaleString() + '</div><div class="stat-label">Tokens</div></div>' +
			'<div class="stat"><div class="stat-value">$' + (cost.total || 0).toFixed(2) + '</div><div class="stat-label">Cost</div></div>' +
			'<div class="stat"><div class="stat-value">' + (totals.llmCalls || 0) + '</div><div class="stat-label">Requests</div></div>' +
			'</div>' +
			'<table><thead><tr><th>Date</th><th>Tokens</th><th>Cost</th><th>Requests</th></tr></thead><tbody>' + rows + '</tbody></table>' +
			'</div>';

		document.getElementById("period").addEventListener("change", function(e) { loadUsage(e.target.value); });
	}

	function loadUsage(period) {
		period = period || "week";
		usageContainer.innerHTML = '<div class="loading">Loading usage data\\u2026</div>';
		callTool("usage__report", { period: period }).then(function(data) {
			var parsed = parseResult(data);
			if (parsed) renderUsage(parsed);
		}).catch(function(err) {
			usageContainer.innerHTML = '<div class="error">Failed to load: ' + (err.message || err) + '</div>';
		});
	}

	loadUsage("week");
`;

export function settingsUsageSection(): string {
  return renderFragment(USAGE_SECTION_STYLES, USAGE_SECTION_SCRIPT);
}
