import { renderFragment } from "../settings-types.ts";

const IDENTITY_SECTION_STYLES = `
.identity-section { padding: 16px; font-family: var(--font-sans, 'Inter', system-ui, sans-serif); }
.identity-section h2 { font-family: var(--nb-font-heading, Georgia, serif); margin: 0 0 12px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary, #171717); }
.identity-section .subtitle { color: var(--color-text-secondary, #737373); font-size: 13px; margin-bottom: 16px; }
.identity-section .effective-view { background: var(--color-background-tertiary, #f8f7f5); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); padding: 14px; white-space: pre-wrap; font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 13px; line-height: 1.5; max-height: 300px; overflow-y: auto; margin-bottom: 16px; color: var(--color-text-primary, #171717); }
.identity-section .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; vertical-align: middle; font-weight: 600; }
.identity-section .badge-core { background: color-mix(in srgb, var(--color-text-accent, #0055FF) 12%, transparent); color: var(--color-text-accent, #0055FF); }
.identity-section .badge-override { background: color-mix(in srgb, var(--nb-color-warning, #f59e0b) 15%, transparent); color: var(--nb-color-warning, #f59e0b); }
.identity-section .actions { display: flex; gap: 8px; margin-bottom: 16px; }
.identity-section .btn { padding: 6px 14px; border-radius: var(--border-radius-sm, 0.5rem); border: 1px solid var(--color-border-primary, #e5e5e5); background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); cursor: pointer; font-size: 13px; transition: background 0.15s; }
.identity-section .btn:hover { background: var(--color-background-tertiary, #f8f7f5); }
.identity-section .btn-primary { background: var(--color-text-accent, #0055FF); border-color: var(--color-text-accent, #0055FF); color: var(--nb-color-accent-foreground, #ffffff); }
.identity-section .btn-primary:hover { opacity: 0.9; }
.identity-section .btn-danger { border-color: var(--nb-color-danger, #dc2626); color: var(--nb-color-danger, #dc2626); }
.identity-section .btn-danger:hover { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent); }
.identity-section .editor { display: none; margin-bottom: 16px; }
.identity-section .editor.visible { display: block; }
.identity-section .editor textarea { width: 100%; min-height: 180px; background: var(--color-background-tertiary, #f8f7f5); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); padding: 12px; color: var(--color-text-primary, #171717); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 13px; line-height: 1.5; resize: vertical; box-sizing: border-box; }
.identity-section .editor textarea:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
.identity-section .editor-actions { display: flex; gap: 8px; margin-top: 8px; }
.identity-section .loading { color: var(--color-text-secondary, #737373); padding: 20px; text-align: center; }
.identity-section .error { color: var(--nb-color-danger, #dc2626); padding: 12px; background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent); border-radius: var(--border-radius-sm, 0.5rem); }
.identity-section .feedback { font-size: 13px; margin-top: 8px; min-height: 20px; }
.identity-section .feedback.error { color: var(--nb-color-danger, #dc2626); }
.identity-section .btn-danger-active { background: var(--nb-color-danger, #dc2626); border-color: var(--nb-color-danger, #dc2626); color: #fff; }
.identity-section .source-label { font-size: 11px; color: var(--color-text-secondary, #737373); margin-bottom: 4px; }
`;

const IDENTITY_SECTION_SCRIPT = `
var idContainer = document.getElementById("section-root") || document.getElementById("app");
var idState = { core: null, override: null, effective: "", editing: false };

async function loadIdentity() {
	idContainer.innerHTML = '<div class="identity-section"><div class="loading">Loading identity\\u2026</div></div>';
	try {
		var result = await callTool("settings__identity", {});
		var data = parseResult(result);
		idState.core = data.core;
		idState.override = data.override;
		idState.effective = data.effective;
		idState.editing = false;
		renderIdentity();
	} catch (err) {
		idContainer.innerHTML = '<div class="identity-section"><div class="error">Failed to load identity: ' + (err.message || err) + '</div></div>';
	}
}

function escapeHtml(str) {
	var div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

function renderIdentity() {
	var overrideBadge = idState.override
		? '<span class="badge badge-override">override active</span>'
		: '<span class="badge badge-core">core only</span>';

	var html = '<div class="identity-section">';
	html += '<h2>Identity ' + overrideBadge + '</h2>';
	html += '<p class="subtitle">Your agent\\'s personality and behavior. The core identity (soul.md) is always present. You can add a custom override that layers on top.</p>';

	html += '<div class="source-label">Effective identity:</div>';
	html += '<div class="effective-view">' + escapeHtml(idState.effective) + '</div>';

	html += '<div class="actions">';
	html += '<button class="btn btn-primary" id="id-edit-btn">Edit Override</button>';
	if (idState.override) {
		html += '<button class="btn btn-danger" id="id-reset-btn">Reset to Default</button>';
	}
	html += '</div>';
	html += '<div class="feedback" id="id-feedback"></div>';

	html += '<div class="editor" id="id-editor">';
	html += '<div class="source-label">Override content (plain markdown):</div>';
	html += '<textarea id="id-textarea">' + escapeHtml(idState.override ? idState.override.body : "") + '</textarea>';
	html += '<div class="editor-actions">';
	html += '<button class="btn btn-primary" id="id-save-btn">Save</button>';
	html += '<button class="btn" id="id-cancel-btn">Cancel</button>';
	html += '</div>';
	html += '</div>';

	html += '</div>';
	idContainer.innerHTML = html;

	document.getElementById("id-edit-btn").addEventListener("click", function() {
		var editor = document.getElementById("id-editor");
		editor.classList.toggle("visible");
		var btn = document.getElementById("id-edit-btn");
		btn.textContent = editor.classList.contains("visible") ? "Hide Editor" : "Edit Override";
	});

	var resetBtn = document.getElementById("id-reset-btn");
	if (resetBtn) {
		var resetConfirming = false;
		resetBtn.addEventListener("click", async function() {
			if (!resetConfirming) {
				resetConfirming = true;
				resetBtn.textContent = "Confirm reset?";
				resetBtn.classList.add("btn-danger-active");
				setTimeout(function() {
					if (resetConfirming) { resetConfirming = false; resetBtn.textContent = "Reset to Default"; resetBtn.classList.remove("btn-danger-active"); }
				}, 4000);
				return;
			}
			resetConfirming = false;
			resetBtn.disabled = true;
			resetBtn.textContent = "Resetting\\u2026";
			try {
				await callTool("nb__manage_identity", { action: "reset" });
				await loadIdentity();
			} catch (err) {
				var errEl = document.getElementById("id-feedback");
				if (errEl) { errEl.textContent = "Failed to reset: " + (err.message || err); errEl.className = "feedback error"; }
				resetBtn.disabled = false;
				resetBtn.textContent = "Reset to Default";
			}
		});
	}

	var saveBtn = document.getElementById("id-save-btn");
	if (saveBtn) {
		saveBtn.addEventListener("click", async function() {
			var textarea = document.getElementById("id-textarea");
			var body = textarea.value.trim();
			var errEl = document.getElementById("id-feedback");
			if (!body) {
				if (errEl) { errEl.textContent = "Identity override cannot be empty. Use Reset to remove it."; errEl.className = "feedback error"; }
				return;
			}
			if (errEl) { errEl.textContent = ""; }
			saveBtn.disabled = true;
			saveBtn.textContent = "Saving\\u2026";
			try {
				await callTool("nb__manage_identity", { body: body });
				await loadIdentity();
			} catch (err) {
				if (errEl) { errEl.textContent = "Failed to save: " + (err.message || err); errEl.className = "feedback error"; }
				saveBtn.disabled = false;
				saveBtn.textContent = "Save";
			}
		});
	}

	var cancelBtn = document.getElementById("id-cancel-btn");
	if (cancelBtn) {
		cancelBtn.addEventListener("click", function() {
			document.getElementById("id-editor").classList.remove("visible");
			document.getElementById("id-edit-btn").textContent = "Edit Override";
			document.getElementById("id-textarea").value = idState.override ? idState.override.body : "";
		});
	}
}

loadIdentity();
`;

export function settingsIdentitySection(): string {
  return renderFragment(IDENTITY_SECTION_STYLES, IDENTITY_SECTION_SCRIPT);
}
