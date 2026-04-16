/**
 * Settings panel HTML — extracted from the settings MCP bundle.
 *
 * Self-contained settings shell with tab navigation that loads sections
 * via tool calls through the MCP App Bridge.
 */

export const SETTINGS_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Settings</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; width: 100%; overflow: hidden; }
  body {
    font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
    font-size: 14px; line-height: 1.5;
    color: var(--color-text-primary, #171717);
    background: var(--color-background-primary, #faf9f7);
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--color-border-primary, #e5e5e5); border-radius: 3px; }

  .settings-shell { display: flex; flex-direction: column; height: 100%; }
  .tab-bar {
    display: flex; gap: 0; border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
    background: var(--color-background-secondary, #ffffff); padding: 0 24px; flex-shrink: 0;
  }
  .tab-select {
    display: none; flex-shrink: 0; padding: 12px 16px;
    border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
    background: var(--color-background-secondary, #ffffff);
  }
  .tab-select select {
    width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: var(--border-radius-sm, 0.5rem); font-size: 14px; font-weight: 500;
    background: var(--color-background-primary, #faf9f7); color: var(--color-text-primary, #171717);
    cursor: pointer; -webkit-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%23737373' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
  }
  .tab-select select:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }
  .tab {
    display: flex; align-items: center; gap: 6px; padding: 12px 16px; border: none;
    background: none; cursor: pointer; font-size: 13px; font-weight: 500;
    color: var(--color-text-secondary, #737373); border-bottom: 2px solid transparent;
    margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; white-space: nowrap;
  }
  .tab:hover { color: var(--color-text-primary, #171717); }
  .tab.active { color: var(--color-text-primary, #171717); border-bottom-color: var(--color-text-primary, #171717); }
  .content { flex: 1; overflow-y: auto; padding: 24px 32px; max-width: 720px; width: 100%; }
  .loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
  .error { color: var(--nb-color-danger, #dc2626); text-align: center; padding: 48px 0; }
  .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px 0; }
  @media (max-width: 600px) {
    .tab-bar { display: none; }
    .tab-select { display: block; }
    .content { padding: 16px; }
  }
</style>
</head>
<body>
<div class="settings-shell">
  <div class="tab-bar" id="tab-bar"></div>
  <div class="tab-select" id="tab-select"><select id="tab-dropdown"></select></div>
  <div class="content" id="content"><div class="loading">Loading\u2026</div></div>
</div>
<script>
// --- Bridge ---
var _pending = {};
var _rpcId = 0;

function callTool(name, args) {
  var server = "settings";
  var tool = name;
  var sep = name.indexOf("__");
  if (sep > 0) { server = name.substring(0, sep); tool = name.substring(sep + 2); }
  var id = "stg-" + (++_rpcId);
  return new Promise(function(resolve, reject) {
    _pending[id] = { resolve: resolve, reject: reject };
    window.parent.postMessage({
      jsonrpc: "2.0", method: "tools/call", id: id,
      params: { server: server, name: tool, arguments: args || {} }
    }, "*");
    setTimeout(function() {
      if (_pending[id]) { delete _pending[id]; reject(new Error("Tool call timed out")); }
    }, 60000);
  });
}

window.addEventListener("message", function(e) {
  var msg = e.data;
  if (!msg || typeof msg !== "object" || !msg.jsonrpc || !msg.id || !_pending[msg.id]) return;
  var p = _pending[msg.id];
  delete _pending[msg.id];
  if (msg.error) { p.reject(new Error(msg.error.message || "Tool call failed")); }
  else { p.resolve(msg.result); }
});

function parseResult(result) {
  if (result && result.content && Array.isArray(result.content)) {
    var text = result.content.map(function(c) { return c.text || ""; }).join("");
    try { return JSON.parse(text); } catch(e) { return text; }
  }
  if (typeof result === "string") {
    try { return JSON.parse(result); } catch(e) { return result; }
  }
  return result;
}

function sendChat(message) {
  window.parent.postMessage({ method: "ui/message", params: { role: "user", content: [{ type: "text", text: message }] } }, "*");
}

// --- Settings shell ---
var activeTab = null;

(async function() {
  try {
    var result = await callTool("settings__manifest", {});
    var data = parseResult(result);
    var sections = data.sections || [];
    if (!sections.length) {
      document.getElementById("content").innerHTML = '<div class="empty">No settings sections available</div>';
      return;
    }
    renderTabs(sections);
    selectTab(sections[0].id);
  } catch (err) {
    document.getElementById("content").innerHTML = '<div class="error">Failed to load settings: ' + (err.message || err) + '</div>';
  }
})();

function renderTabs(sections) {
  var bar = document.getElementById("tab-bar");
  bar.innerHTML = sections.map(function(s) {
    return '<button class="tab" data-id="' + s.id + '"><span class="tab-label">' + s.label + '</span></button>';
  }).join("");
  bar.addEventListener("click", function(e) {
    var tab = e.target.closest(".tab");
    if (tab) selectTab(tab.dataset.id);
  });
  var dropdown = document.getElementById("tab-dropdown");
  dropdown.innerHTML = sections.map(function(s) {
    return '<option value="' + s.id + '">' + s.label + '</option>';
  }).join("");
  dropdown.addEventListener("change", function(e) {
    selectTab(e.target.value);
  });
}

async function selectTab(id) {
  activeTab = id;
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function(t) { t.classList.toggle("active", t.dataset.id === id); });
  var dropdown = document.getElementById("tab-dropdown");
  if (dropdown.value !== id) dropdown.value = id;
  var content = document.getElementById("content");
  content.innerHTML = '<div class="loading">Loading\u2026</div>';
  try {
    var result = await callTool("settings__section", { id: id });
    var data = parseResult(result);
    var html = typeof data === "string" ? data : (data.html || "");
    if (activeTab !== id) return;
    content.innerHTML = html;
    var scripts = content.querySelectorAll("script");
    scripts.forEach(function(orig) {
      var s = document.createElement("script");
      s.textContent = orig.textContent;
      orig.parentNode.replaceChild(s, orig);
    });
  } catch (err) {
    if (activeTab !== id) return;
    content.innerHTML = '<div class="error">Failed to load section: ' + (err.message || err) + '</div>';
  }
}
</script>
</body>
</html>`;
