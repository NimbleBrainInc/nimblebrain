import { renderFragment } from "../settings-types.ts";

const PROFILE_SECTION_STYLES = `
	.page { max-width: 600px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 4px; }
	.subtitle { font-size: 13px; color: var(--color-text-secondary, #737373); margin-bottom: 24px; }
	.field { margin-bottom: 20px; }
	.field label { display: block; font-size: 13px; font-weight: 500; color: var(--color-text-primary, #171717); margin-bottom: 6px; }
	.field input, .field select {
		display: block; width: 100%; padding: 8px 12px; margin: 0;
		border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem);
		font-family: inherit; font-size: 14px; color: var(--color-text-primary, #171717);
		background: var(--color-background-secondary, #ffffff); outline: none; transition: border-color 0.15s;
		box-sizing: border-box; -webkit-appearance: none; appearance: none;
	}
	.field select {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%23737373' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
	}
	.field input:focus, .field select:focus { border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
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
	.loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
`;

const PROFILE_SECTION_SCRIPT = `
	var app = document.getElementById("section-root") || document.getElementById("app");
	app.innerHTML = '<div class="loading">Loading profile\\u2026</div>';

	(async function() {
		try {
			var raw = await callTool("settings__config", {});
			var cfg = parseResult(raw);
		} catch (e) {
			app.innerHTML = '<div class="page"><div class="error" style="color:var(--nb-color-danger,#dc2626)">Failed to load profile.</div></div>';
			return;
		}

		var prefs = cfg.preferences || {};

		// Build timezone dropdown from Intl API
		var tzOptions = '<option value="">(System default)</option>';
		try {
			var allZones = Intl.supportedValuesOf("timeZone");
			var grouped = {};
			for (var i = 0; i < allZones.length; i++) {
				var tz = allZones[i];
				var region = tz.indexOf("/") > -1 ? tz.split("/")[0] : "Other";
				if (!grouped[region]) grouped[region] = [];
				grouped[region].push(tz);
			}
			var regions = Object.keys(grouped).sort();
			for (var r = 0; r < regions.length; r++) {
				var region = regions[r];
				var zones = grouped[region];
				tzOptions += '<optgroup label="' + region + '">';
				for (var z = 0; z < zones.length; z++) {
					var tz = zones[z];
					var label = tz.replace(/_/g, " ");
					try {
						var now = new Date();
						var fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
						var parts = fmt.formatToParts(now);
						var offset = "";
						for (var p = 0; p < parts.length; p++) {
							if (parts[p].type === "timeZoneName") { offset = parts[p].value; break; }
						}
						if (offset) label += " (" + offset + ")";
					} catch(e) {}
					var sel = (prefs.timezone === tz) ? " selected" : "";
					tzOptions += '<option value="' + tz + '"' + sel + '>' + label + '</option>';
				}
				tzOptions += '</optgroup>';
			}
		} catch(e) {
			// Fallback for older browsers without Intl.supportedValuesOf
			var commonZones = [
				"Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
				"America/Chicago", "America/New_York", "America/Sao_Paulo", "Europe/London",
				"Europe/Paris", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai",
				"Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"
			];
			for (var i = 0; i < commonZones.length; i++) {
				var sel = (prefs.timezone === commonZones[i]) ? " selected" : "";
				tzOptions += '<option value="' + commonZones[i] + '"' + sel + '>' + commonZones[i].replace(/_/g, " ") + '</option>';
			}
		}

		app.innerHTML = '<div class="page">'
			+ '<h1>Profile</h1>'
			+ '<p class="subtitle">Your preferences. Changes are saved to your user profile.</p>'
			+ '<div class="field"><label for="pref-name">Display Name</label>'
			+ '<input type="text" id="pref-name" placeholder="Your name" value="' + (prefs.displayName || '').replace(/"/g, '&quot;') + '" />'
			+ '<div class="hint">Used in greetings and the Home dashboard.</div></div>'
			+ '<div class="field"><label for="pref-tz">Timezone</label>'
			+ '<select id="pref-tz">' + tzOptions + '</select>'
			+ '<div class="hint">IANA timezone for time-aware features.</div></div>'
			+ '<div class="field"><label for="pref-locale">Language</label>'
			+ '<select id="pref-locale">'
			+ (function() {
				var locales = [
					["en-US", "English (US)"],
					["en-GB", "English (UK)"],
					["en-AU", "English (Australia)"],
					["es-ES", "Spanish (Spain)"],
					["es-MX", "Spanish (Mexico)"],
					["fr-FR", "French"],
					["de-DE", "German"],
					["it-IT", "Italian"],
					["pt-BR", "Portuguese (Brazil)"],
					["pt-PT", "Portuguese (Portugal)"],
					["nl-NL", "Dutch"],
					["ja-JP", "Japanese"],
					["ko-KR", "Korean"],
					["zh-CN", "Chinese (Simplified)"],
					["zh-TW", "Chinese (Traditional)"],
					["ar-SA", "Arabic"],
					["hi-IN", "Hindi"],
					["ru-RU", "Russian"],
					["pl-PL", "Polish"],
					["sv-SE", "Swedish"],
					["da-DK", "Danish"],
					["fi-FI", "Finnish"],
					["nb-NO", "Norwegian"],
					["th-TH", "Thai"],
					["vi-VN", "Vietnamese"],
					["tr-TR", "Turkish"],
					["uk-UA", "Ukrainian"],
					["he-IL", "Hebrew"],
					["id-ID", "Indonesian"],
					["ms-MY", "Malay"],
				];
				var currentLocale = prefs.locale || "en-US";
				var opts = "";
				for (var i = 0; i < locales.length; i++) {
					var sel = (currentLocale === locales[i][0]) ? " selected" : "";
					opts += '<option value="' + locales[i][0] + '"' + sel + '>' + locales[i][1] + '</option>';
				}
				return opts;
			})()
			+ '</select>'
			+ '<div class="hint">Controls date, number, and currency formatting.</div></div>'
			+ '<div class="field"><label for="pref-theme">Theme</label>'
			+ '<select id="pref-theme">'
			+ '<option value="system"' + (prefs.theme === 'system' || !prefs.theme ? ' selected' : '') + '>System</option>'
			+ '<option value="light"' + (prefs.theme === 'light' ? ' selected' : '') + '>Light</option>'
			+ '<option value="dark"' + (prefs.theme === 'dark' ? ' selected' : '') + '>Dark</option>'
			+ '</select></div>'
			+ '<div class="actions">'
			+ '<button class="save-btn" id="pref-save">Save</button>'
			+ '<span class="feedback" id="pref-feedback"></span>'
			+ '</div>'
			+ '</div>';

		var saveBtn = document.getElementById("pref-save");
		var feedback = document.getElementById("pref-feedback");

		saveBtn.addEventListener("click", async function() {
			saveBtn.disabled = true;
			feedback.textContent = "";
			feedback.className = "feedback";

			var patch = {
				displayName: document.getElementById("pref-name").value.trim(),
				timezone: document.getElementById("pref-tz").value.trim(),
				locale: document.getElementById("pref-locale").value.trim() || "en-US",
				theme: document.getElementById("pref-theme").value,
			};

			try {
				var result = await callTool("nb__set_preferences", patch);
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

export function settingsProfileSection(): string {
  return renderFragment(PROFILE_SECTION_STYLES, PROFILE_SECTION_SCRIPT);
}
