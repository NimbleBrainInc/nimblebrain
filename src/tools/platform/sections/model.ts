import { renderFragment } from "../settings-types.ts";

const CONFIG_SECTION_STYLES = `
	.page { max-width: 600px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 4px; }
	.subtitle { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 24px; }
	.field { margin-bottom: 20px; }
	.field label { display: block; font-size: 13px; font-weight: 500; color: var(--color-text-primary, #171717); margin-bottom: 6px; }
	.field select, .field input[type="number"] {
		width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem);
		font-size: 14px; color: var(--color-text-primary, #171717); background: var(--color-background-secondary, #ffffff); outline: none; transition: border-color 0.15s;
	}
	.field select:focus, .field input[type="number"]:focus { border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
	.field .hint { font-size: 11px; color: var(--color-text-secondary, #737373); margin-top: 4px; }
	.actions { display: flex; align-items: center; gap: 12px; margin-top: 28px; }
	.save-btn {
		font-size: 13px; padding: 8px 20px; border: none; border-radius: var(--border-radius-sm, 0.5rem);
		background: var(--color-text-accent, #0055FF); color: var(--nb-color-accent-foreground, #ffffff); cursor: pointer; font-weight: 500; transition: opacity 0.15s;
	}
	.save-btn:hover { opacity: 0.9; }
	.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.feedback { font-size: 13px; transition: opacity 0.3s; }
	.feedback.success { color: var(--nb-color-success, #059669); }
	.feedback.error { color: var(--nb-color-danger, #dc2626); }
`;

const CONFIG_SECTION_SCRIPT = `
	var app = document.getElementById("section-root") || document.getElementById("app");
	app.innerHTML = '<div class="page"><div class="loading" style="color:var(--color-text-secondary,#737373)">Loading config\\u2026</div></div>';

	(async function() {
		try {
			var raw = await callTool("nb__get_config", {});
			var cfg = parseResult(raw);
		} catch (e) {
			app.innerHTML = '<div class="page"><div class="error" style="color:var(--nb-color-danger,#dc2626)">Failed to load config.</div></div>';
			return;
		}

		// Build model option HTML from catalog data (grouped by provider)
		var catalogModels = cfg.availableModels || {};
		var providerNames = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
		var slots = cfg.models || {};

		function buildModelOptions(selectedValue) {
			var html = '';
			Object.keys(catalogModels).forEach(function(provider) {
				var models = catalogModels[provider] || [];
				if (models.length === 0) return;
				var label = providerNames[provider] || provider;
				var opts = models.map(function(m) {
					var val = provider + ':' + m.id;
					var price = '$' + m.cost.input + '/$' + m.cost.output + '/M';
					var ctx = m.limits.context >= 1000000 ? (m.limits.context / 1000000) + 'M' : Math.round(m.limits.context / 1000) + 'K';
					var display = m.id + '  (' + price + ', ' + ctx + ' ctx)';
					return '<option value="' + val + '"' + (val === selectedValue ? ' selected' : '') + '>' + display + '</option>';
				}).join('');
				html += '<optgroup label="' + label + '">' + opts + '</optgroup>';
			});
			return html;
		}

		app.innerHTML = '<div class="page">'
			+ '<h1>Configuration</h1>'
			+ '<p class="subtitle">Model slots and runtime limits. Changes take effect on the next chat turn.</p>'
			+ '<div class="field"><label for="cfg-model-default">Default Model</label>'
			+ '<select id="cfg-model-default">' + buildModelOptions(slots.default || '') + '</select>'
			+ '<div class="hint">Primary model for chat and general requests.</div></div>'
			+ '<div class="field"><label for="cfg-model-fast">Fast Model</label>'
			+ '<select id="cfg-model-fast">' + buildModelOptions(slots.fast || '') + '</select>'
			+ '<div class="hint">Cheap/fast model for briefings, auto-title, and auxiliary tasks.</div></div>'
			+ '<div class="field"><label for="cfg-model-reasoning">Reasoning Model</label>'
			+ '<select id="cfg-model-reasoning">' + buildModelOptions(slots.reasoning || '') + '</select>'
			+ '<div class="hint">Most capable model for complex analysis and planning.</div></div>'
			+ '<div class="field"><label for="cfg-iter">Max Iterations</label>'
			+ '<input type="number" id="cfg-iter" min="1" max="50" value="' + cfg.maxIterations + '" />'
			+ '<div class="hint">1-50. Number of agentic loop iterations per request.</div></div>'
			+ '<div class="field"><label for="cfg-input">Max Input Tokens</label>'
			+ '<input type="number" id="cfg-input" min="1" value="' + cfg.maxInputTokens + '" />'
			+ '<div class="hint">Context window budget per request.</div></div>'
			+ '<div class="field"><label for="cfg-output">Max Output Tokens</label>'
			+ '<input type="number" id="cfg-output" min="1" value="' + cfg.maxOutputTokens + '" />'
			+ '<div class="hint">Maximum tokens per LLM response.</div></div>'
			+ '<div class="field"><label for="cfg-thinking">Extended Thinking</label>'
			+ '<select id="cfg-thinking">'
			+ '<option value="">Default (adaptive for reasoning models, off otherwise)</option>'
			+ '<option value="off"' + (cfg.thinking === "off" ? " selected" : "") + '>Off — never reason</option>'
			+ '<option value="adaptive"' + (cfg.thinking === "adaptive" ? " selected" : "") + '>Adaptive — model decides per call</option>'
			+ '<option value="enabled"' + (cfg.thinking === "enabled" ? " selected" : "") + '>Enabled — always reason</option>'
			+ '</select>'
			+ '<div class="hint">Anthropic-only today. Reasoning is billed; adaptive only engages when the model judges it useful.</div></div>'
			+ '<div class="field" id="cfg-budget-row" style="' + (cfg.thinking === "enabled" ? "" : "display:none") + '">'
			+ '<label for="cfg-budget">Thinking Budget Tokens</label>'
			+ '<input type="number" id="cfg-budget" min="1024" value="' + (cfg.thinkingBudgetTokens || 16000) + '" />'
			+ '<div class="hint">Min 1024. Counts toward Max Output Tokens.</div></div>'
			+ '<div class="actions">'
			+ '<button class="save-btn" id="cfg-save">Save</button>'
			+ '<span class="feedback" id="cfg-feedback"></span>'
			+ '</div>'
			+ '</div>';

		var saveBtn = document.getElementById("cfg-save");
		var feedback = document.getElementById("cfg-feedback");
		var thinkingSel = document.getElementById("cfg-thinking");
		var budgetRow = document.getElementById("cfg-budget-row");
		thinkingSel.addEventListener("change", function() {
			budgetRow.style.display = thinkingSel.value === "enabled" ? "" : "none";
		});

		saveBtn.addEventListener("click", async function() {
			saveBtn.disabled = true;
			feedback.textContent = "";
			feedback.className = "feedback";

			var patch = {
				models: {
					default: document.getElementById("cfg-model-default").value,
					fast: document.getElementById("cfg-model-fast").value,
					reasoning: document.getElementById("cfg-model-reasoning").value,
				},
				maxIterations: parseInt(document.getElementById("cfg-iter").value, 10),
				maxInputTokens: parseInt(document.getElementById("cfg-input").value, 10),
				maxOutputTokens: parseInt(document.getElementById("cfg-output").value, 10),
			};
			var thinkingValue = thinkingSel.value;
			if (thinkingValue === "") {
				// "Default" — clear any persisted override so the resolver falls
				// back to the platform default policy.
				patch.thinking = null;
				patch.thinkingBudgetTokens = null;
			} else {
				patch.thinking = thinkingValue;
				if (thinkingValue === "enabled") {
					patch.thinkingBudgetTokens = parseInt(document.getElementById("cfg-budget").value, 10);
				}
			}

			try {
				var result = await callTool("nb__set_model_config", patch);
				var parsed = parseResult(result);
				if (parsed && parsed.success) {
					feedback.textContent = "Saved";
					feedback.className = "feedback success";
				} else {
					feedback.textContent = typeof parsed === "string" ? parsed : "Save failed";
					feedback.className = "feedback error";
				}
			} catch (e) {
				feedback.textContent = e && e.message ? e.message : "Save failed";
				feedback.className = "feedback error";
			}

			saveBtn.disabled = false;
			setTimeout(function() { feedback.style.opacity = "0"; }, 3000);
			setTimeout(function() { feedback.textContent = ""; feedback.style.opacity = "1"; }, 3600);
		});
	})();
`;

export function settingsConfigSection(): string {
  return renderFragment(CONFIG_SECTION_STYLES, CONFIG_SECTION_SCRIPT);
}
