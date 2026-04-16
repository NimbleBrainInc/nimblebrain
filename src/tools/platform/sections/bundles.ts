import { renderFragment } from "../settings-types.ts";

const BUNDLES_SECTION_STYLES = `
	.page { max-width: 720px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 8px; }
	.subtitle { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 24px; }
	.bundle-card {
		display: flex; justify-content: space-between; align-items: center;
		padding: 14px 16px; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5);
		border-radius: var(--border-radius-sm, 0.625rem); margin-bottom: 8px;
	}
	.bundle-info { flex: 1; min-width: 0; }
	.bundle-name { font-weight: 500; color: var(--color-text-primary, #171717); font-size: 14px; }
	.bundle-version { font-size: 12px; color: var(--color-text-secondary, #737373); margin-left: 6px; font-weight: 400; }
	.bundle-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
	.badge {
		font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px;
		text-transform: uppercase; letter-spacing: 0.3px;
	}
	.badge-running { background: color-mix(in srgb, var(--nb-color-success, #059669) 15%, transparent); color: var(--nb-color-success, #059669); }
	.badge-stopped { background: color-mix(in srgb, var(--color-text-secondary, #737373) 15%, transparent); color: var(--color-text-secondary, #737373); }
	.badge-crashed { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 15%, transparent); color: var(--nb-color-danger, #dc2626); }
	.badge-protected { background: color-mix(in srgb, var(--color-text-accent, #0055FF) 10%, transparent); color: var(--color-text-accent, #0055FF); }
	.badge-tools { background: color-mix(in srgb, var(--color-text-primary, #171717) 8%, transparent); color: var(--color-text-secondary, #737373); }
	.badge-trust { background: color-mix(in srgb, #7c3aed 10%, transparent); color: #7c3aed; }
	.bundle-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; margin-left: 12px; }
	.action-btn {
		font-size: 12px; padding: 4px 10px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem);
		background: var(--color-background-secondary, #ffffff); cursor: pointer; color: var(--color-text-primary, #171717); transition: all 0.15s;
	}
	.action-btn:hover { background: var(--color-background-tertiary, #f8f7f5); }
	.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.action-btn.danger { color: var(--nb-color-danger, #dc2626); }
	.action-btn.danger:hover { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent); }
	.loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
	.error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
	.empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
`;

const BUNDLES_SECTION_SCRIPT = `
var bundlesContainer = document.getElementById("section-root") || document.getElementById("app");

async function loadBundles() {
	bundlesContainer.innerHTML = '<div class="loading">Loading bundles\\u2026</div>';
	try {
		var result = await callTool("nb__list_apps", {});
		var apps = parseResult(result);
		if (!apps || !Array.isArray(apps)) {
			if (typeof apps === "string") {
				try { apps = JSON.parse(apps); } catch(e) { apps = []; }
			} else {
				apps = [];
			}
		}
		renderBundles(apps);
	} catch (err) {
		bundlesContainer.innerHTML = '<div class="error">Failed to load bundles: ' + (err.message || err) + '</div>';
	}
}

function escapeHtml(str) {
	var div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

function renderBundleCard(app) {
	var statusClass = app.status === "running" ? "badge-running" : app.status === "crashed" || app.status === "dead" ? "badge-crashed" : "badge-stopped";
	var html = '<div class="bundle-card">';
	html += '<div class="bundle-info">';
	html += '<div><span class="bundle-name">' + escapeHtml(app.bundleName || app.name) + '</span>';
	if (app.version) html += '<span class="bundle-version">v' + escapeHtml(app.version) + '</span>';
	html += '</div>';
	html += '<div class="bundle-meta">';
	html += '<span class="badge ' + statusClass + '">' + escapeHtml(app.status || "unknown") + '</span>';
	html += '<span class="badge badge-tools">' + (app.toolCount || 0) + ' tools</span>';
	if (app.trustScore > 0) html += '<span class="badge badge-trust">trust ' + app.trustScore + '</span>';
	html += '</div></div>';

	html += '<div class="bundle-actions">';
	if (app.status === "running") {
		html += '<button class="action-btn" data-action="stop" data-name="' + escapeHtml(app.name) + '">Stop</button>';
	} else if (app.status === "stopped") {
		html += '<button class="action-btn" data-action="start" data-name="' + escapeHtml(app.name) + '">Start</button>';
	}
	html += '</div>';
	html += '</div>';
	return html;
}

function renderBundles(apps) {
	if (apps.length === 0) {
		bundlesContainer.innerHTML = '<div class="page"><h1>Bundles</h1><p class="subtitle">Installed MCP bundles and their status.</p><div class="empty">No bundles installed</div></div>';
		return;
	}
	var html = '<div class="page"><h1>Bundles</h1>';
	html += '<p class="subtitle">Installed MCP bundles and their status. Manage bundles via chat.</p>';
	for (var i = 0; i < apps.length; i++) {
		html += renderBundleCard(apps[i]);
	}
	html += '</div>';
	bundlesContainer.innerHTML = html;

	var actionBtns = bundlesContainer.querySelectorAll("[data-action]");
	for (var i = 0; i < actionBtns.length; i++) {
		(function(btn) {
			btn.addEventListener("click", async function() {
				var action = btn.getAttribute("data-action");
				var name = btn.getAttribute("data-name");
				btn.disabled = true;
				btn.textContent = action === "stop" ? "Stopping\\u2026" : "Starting\\u2026";
				try {
					await callTool("nb__manage_app", { action: action, name: name });
					await loadBundles();
				} catch (err) {
					btn.textContent = "Error: " + (err.message || err);
					btn.style.color = "var(--nb-color-danger, #dc2626)";
					setTimeout(function() { loadBundles(); }, 3000);
				}
			});
		})(actionBtns[i]);
	}
}

loadBundles();
`;

export function settingsBundlesSection(): string {
  return renderFragment(BUNDLES_SECTION_STYLES, BUNDLES_SECTION_SCRIPT);
}
