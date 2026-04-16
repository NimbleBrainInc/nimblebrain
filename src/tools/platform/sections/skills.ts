import { renderFragment } from "../settings-types.ts";

const SKILLS_SECTION_STYLES = `
	.page { max-width: 720px; }
	h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 8px; }
	.header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
	.create-btn {
		font-size: 13px; padding: 6px 14px; border: 1px solid var(--color-text-accent, #0055FF); border-radius: var(--border-radius-sm, 0.5rem);
		background: var(--color-text-accent, #0055FF); color: var(--nb-color-accent-foreground, #ffffff); cursor: pointer; font-weight: 500; transition: background 0.15s;
	}
	.create-btn:hover { opacity: 0.9; }
	.section { margin-bottom: 28px; }
	.section-title {
		font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase;
		letter-spacing: 0.5px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
	}
	.skill-card {
		display: flex; justify-content: space-between; align-items: flex-start;
		padding: 12px 16px; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.625rem); margin-bottom: 8px;
	}
	.skill-info { flex: 1; min-width: 0; }
	.skill-name { font-weight: 500; color: var(--color-text-primary, #171717); font-size: 14px; }
	.skill-desc { font-size: 12px; color: var(--color-text-secondary, #737373); margin-top: 2px; }
	.skill-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
	.badge {
		font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px;
		text-transform: uppercase; letter-spacing: 0.3px;
	}
	.badge-immutable { background: color-mix(in srgb, var(--color-text-accent, #0055FF) 10%, transparent); color: var(--color-text-accent, #0055FF); }
	.badge-priority { background: color-mix(in srgb, #7c3aed 10%, transparent); color: #7c3aed; }
	.badge-trigger { background: color-mix(in srgb, var(--nb-color-warning, #f59e0b) 15%, transparent); color: var(--nb-color-warning, #f59e0b); }
	.badge-installed { background: color-mix(in srgb, var(--nb-color-success, #059669) 15%, transparent); color: var(--nb-color-success, #059669); }
	.badge-missing { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 15%, transparent); color: var(--nb-color-danger, #dc2626); }
	.skill-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; margin-left: 12px; }
	.edit-link {
		font-size: 12px; color: var(--color-text-accent, #0055FF); cursor: pointer; background: none; border: none;
		text-decoration: none; padding: 4px 8px;
	}
	.edit-link:hover { text-decoration: underline; }
	.delete-btn {
		font-size: 12px; padding: 4px 10px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem);
		background: var(--color-background-secondary, #ffffff); cursor: pointer; color: var(--nb-color-danger, #dc2626); transition: all 0.15s;
	}
	.delete-btn:hover { background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent); }
	.loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
	.error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
	.empty-group { color: var(--color-text-secondary, #737373); font-size: 13px; padding: 12px 0; }
`;

const SKILLS_SECTION_SCRIPT = `
var skillsContainer = document.getElementById("section-root") || document.getElementById("app");

async function loadSkills() {
	skillsContainer.innerHTML = '<div class="loading">Loading skills\\u2026</div>';
	try {
		var result = await callTool("nb__status", { scope: "skills" });
		var text = "";
		if (typeof result === "string") {
			text = result;
		} else if (result && result.content && Array.isArray(result.content)) {
			text = result.content.map(function(c) { return c.text || ""; }).join("");
		} else if (result && typeof result === "object") {
			text = typeof result.result === "string" ? result.result : JSON.stringify(result);
		}
		if (!text) {
			skillsContainer.innerHTML = '<div class="error">No skill data returned. Is the platform running?</div>';
			return;
		}
		renderSkills(text);
	} catch (err) {
		skillsContainer.innerHTML = '<div class="error">Failed to load skills: ' + (err.message || err) + '</div>';
	}
}

function parseSkillsText(text) {
	var groups = { core: [], user: [], matchable: [] };
	var currentGroup = null;
	var lines = text.split("\\n");
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("## Core Skills") === 0) { currentGroup = "core"; continue; }
		if (line.indexOf("## User Context Skills") === 0) { currentGroup = "user"; continue; }
		if (line.indexOf("## Matchable Skills") === 0) { currentGroup = "matchable"; continue; }
		if (!currentGroup || !line.startsWith("- ")) continue;

		var entry = { name: "", type: "", priority: "", description: "", triggers: [], deps: [] };
		var match = line.match(/^- ([^ ]+) \\\\(([^,]+), priority (\\\\d+)\\\\) — (.*)$/);
		if (match) {
			entry.name = match[1];
			entry.type = match[2];
			entry.priority = match[3];
			entry.description = match[4];
		}

		// Check subsequent indented lines for triggers and deps
		while (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
			i++;
			var sub = lines[i].trim();
			if (sub.startsWith("Triggers:")) {
				var trigStr = sub.replace("Triggers:", "").trim();
				var trigMatches = trigStr.match(/"([^"]+)"/g);
				if (trigMatches) {
					entry.triggers = trigMatches.map(function(t) { return t.replace(/"/g, ""); });
				}
			} else if (sub.startsWith("Dependencies:")) {
				var depStr = sub.replace("Dependencies:", "").trim();
				var depParts = depStr.split(", ");
				entry.deps = depParts.map(function(d) {
					var dm = d.match(/^(.+) \\\\((installed|missing)\\\\)$/);
					if (dm) return { name: dm[1], status: dm[2] };
					return { name: d, status: "unknown" };
				});
			}
		}
		groups[currentGroup].push(entry);
	}
	return groups;
}

function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSkillCard(skill, groupType) {
	var isCore = groupType === "core";
	var html = '<div class="skill-card">';
	html += '<div class="skill-info">';
	html += '<div class="skill-name">' + escapeHtml(skill.name) + '</div>';
	if (skill.description && skill.description !== "(no description)") {
		html += '<div class="skill-desc">' + escapeHtml(skill.description) + '</div>';
	}
	html += '<div class="skill-meta">';
	if (isCore) {
		html += '<span class="badge badge-immutable">immutable</span>';
	}
	if (groupType === "user") {
		html += '<span class="badge badge-priority">priority ' + escapeHtml(skill.priority) + '</span>';
	}
	if (skill.triggers && skill.triggers.length > 0) {
		for (var t = 0; t < skill.triggers.length; t++) {
			html += '<span class="badge badge-trigger">' + escapeHtml(skill.triggers[t]) + '</span>';
		}
	}
	if (skill.deps && skill.deps.length > 0) {
		for (var d = 0; d < skill.deps.length; d++) {
			var dep = skill.deps[d];
			var cls = dep.status === "installed" ? "badge-installed" : "badge-missing";
			html += '<span class="badge ' + cls + '">' + escapeHtml(dep.name) + ' ' + dep.status + '</span>';
		}
	}
	html += '</div></div>';

	if (!isCore) {
		html += '<div class="skill-actions">';
		html += '<button class="edit-link" data-action="edit" data-name="' + escapeHtml(skill.name) + '">Edit</button>';
		html += '<button class="delete-btn" data-action="delete" data-name="' + escapeHtml(skill.name) + '">Delete</button>';
		html += '</div>';
	}
	html += '</div>';
	return html;
}

function renderGroup(title, skills, groupType) {
	var html = '<div class="section">';
	html += '<div class="section-title">' + escapeHtml(title) + '</div>';
	if (skills.length === 0) {
		html += '<div class="empty-group">No skills in this group</div>';
	} else {
		for (var i = 0; i < skills.length; i++) {
			html += renderSkillCard(skills[i], groupType);
		}
	}
	html += '</div>';
	return html;
}

function renderSkills(text) {
	var groups = parseSkillsText(text);
	var html = '<div class="page">';
	html += '<div class="header-row"><h1>Skills &amp; Personas</h1>';
	html += '<button class="create-btn" id="create-skill-btn">+ Create Skill</button></div>';

	if (groups.core.length > 0) {
		html += renderGroup("Core Skills", groups.core, "core");
	}
	if (groups.user.length > 0) {
		html += renderGroup("User Context Skills", groups.user, "user");
	}
	if (groups.matchable.length > 0) {
		html += renderGroup("Matchable Skills", groups.matchable, "matchable");
	}
	if (groups.core.length === 0 && groups.user.length === 0 && groups.matchable.length === 0) {
		html += '<div class="loading">No skills loaded</div>';
	}

	html += '</div>';
	skillsContainer.innerHTML = html;
	attachHandlers();
}

function attachHandlers() {
	var createBtn = document.getElementById("create-skill-btn");
	if (createBtn) {
		createBtn.addEventListener("click", function() {
			sendChat("Create a new skill for ");
		});
	}

	var actionBtns = skillsContainer.querySelectorAll("[data-action]");
	for (var i = 0; i < actionBtns.length; i++) {
		(function(btn) {
			var pendingDelete = false;
			btn.addEventListener("click", function() {
				var action = btn.getAttribute("data-action");
				var name = btn.getAttribute("data-name");
				if (action === "delete") {
					if (!pendingDelete) {
						pendingDelete = true;
						btn.textContent = "Confirm?";
						btn.style.color = "var(--nb-color-danger, #dc2626)";
						btn.style.fontWeight = "600";
						setTimeout(function() { if (pendingDelete) { pendingDelete = false; btn.textContent = "Delete"; btn.style.color = ""; btn.style.fontWeight = ""; } }, 4000);
						return;
					}
					pendingDelete = false;
					btn.disabled = true;
					btn.textContent = "Deleting\\u2026";
					callTool("nb__manage_skill", { action: "delete", name: name }).then(function() {
						loadSkills();
					});
				} else if (action === "edit") {
					sendChat("Edit the " + name + " skill to ");
				}
			});
		})(actionBtns[i]);
	}
}

loadSkills();
`;

export function settingsSkillsSection(): string {
  return renderFragment(SKILLS_SECTION_STYLES, SKILLS_SECTION_SCRIPT);
}
