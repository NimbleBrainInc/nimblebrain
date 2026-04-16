import { BRIDGE_HELPER } from "./_bridge.ts";

/**
 * Manifest-driven settings shell.
 *
 * On load, discovers sections via settings_manifest, renders a tab bar,
 * and fetches section HTML on tab click via settings_section.
 * Zero knowledge of specific sections — purely dynamic.
 */
export const SETTINGS_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");

let activeTab = null;

async function loadManifest() {
  app.innerHTML =
    '<div class="settings-shell">' +
      '<div class="tab-bar" id="tab-bar"></div>' +
      '<div class="tab-select" id="tab-select"><select id="tab-dropdown"></select></div>' +
      '<div class="content" id="content"><div class="loading">Loading…</div></div>' +
    '</div>';

  try {
    const result = await callTool("settings_manifest", {});
    const data = parseResult(result);
    const sections = data.sections || [];
    if (!sections.length) {
      document.getElementById("content").innerHTML =
        '<div class="empty">No settings sections available</div>';
      return;
    }
    renderTabs(sections);
    selectTab(sections[0].id);
  } catch (err) {
    document.getElementById("content").innerHTML =
      '<div class="error">Failed to load settings: ' + (err.message || err) + '</div>';
  }
}

function renderTabs(sections) {
  const bar = document.getElementById("tab-bar");
  bar.innerHTML = sections.map(function(s) {
    return '<button class="tab" data-id="' + s.id + '">' +
      (s.icon ? '<span class="tab-icon">' + s.icon + '</span>' : '') +
      '<span class="tab-label">' + s.label + '</span>' +
    '</button>';
  }).join("");

  bar.addEventListener("click", function(e) {
    const tab = e.target.closest(".tab");
    if (tab) selectTab(tab.dataset.id);
  });
  const dropdown = document.getElementById("tab-dropdown");
  dropdown.innerHTML = sections.map(function(s) {
    return '<option value="' + s.id + '">' + s.label + '</option>';
  }).join("");
  dropdown.addEventListener("change", function(e) {
    selectTab(e.target.value);
  });
}

async function selectTab(id) {
  activeTab = id;
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(function(t) {
    t.classList.toggle("active", t.dataset.id === id);
  });
  const dropdown = document.getElementById("tab-dropdown");
  if (dropdown.value !== id) dropdown.value = id;

  const content = document.getElementById("content");
  content.innerHTML = '<div class="loading">Loading…</div>';

  try {
    const result = await callTool("settings_section", { id: id });
    const data = parseResult(result);
    const html = typeof data === "string" ? data : (data.html || "");
    if (activeTab !== id) return;
    content.innerHTML = html;

    const scripts = content.querySelectorAll("script");
    scripts.forEach(function(orig) {
      const s = document.createElement("script");
      s.textContent = orig.textContent;
      orig.parentNode.replaceChild(s, orig);
    });
  } catch (err) {
    if (activeTab !== id) return;
    content.innerHTML =
      '<div class="error">Failed to load section: ' + (err.message || err) + '</div>';
  }
}

loadManifest();
`;
