/**
 * Self-contained HTML/CSS/JS for the files browser.
 *
 * Served as an MCP resource at ui://files/browser.
 * Rendered in a platform iframe with the postMessage bridge for tool calls.
 *
 * All CSS uses ext-apps spec tokens and NB extension tokens injected by the platform. No external resources.
 */

export const FILES_BROWSER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Files</title>
<style>
  /* ===== Reset & Base ===== */
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; width: 100%; overflow: hidden; }
  body {
    font-family: var(--font-sans, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: 15px;
    line-height: 1.5;
    color: var(--color-text-primary, #171717);
    background: var(--color-background-primary, #faf9f7);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  #app { height: 100%; width: 100%; display: flex; flex-direction: column; overflow: hidden; }

  /* ===== Scrollbar ===== */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--color-border-primary, #e5e5e5); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--color-text-secondary, #737373); }

  /* ===== Animations ===== */
  @keyframes breathe { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }
  .skel {
    background: var(--color-border-primary, #e5e5e5);
    border-radius: var(--border-radius-sm, 0.5rem);
    animation: breathe 3s ease-in-out infinite;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ===== Header ===== */
  .header {
    position: sticky; top: 0; z-index: 10;
    background: var(--color-background-primary, #faf9f7);
    padding: 20px 20px 0;
    flex-shrink: 0;
  }
  .header-top {
    display: flex; justify-content: space-between; align-items: center;
  }
  .header-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.025em;
    line-height: 1.3;
    color: var(--color-text-primary, #171717);
  }
  .header-lede {
    font-size: 14px;
    color: var(--color-text-secondary, #737373);
    margin-top: 2px;
    line-height: 1.4;
  }

  /* ===== Upload Button ===== */
  .upload-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    border: 1px solid var(--color-text-accent, #0055FF);
    border-radius: 20px;
    background: transparent;
    color: var(--color-text-accent, #0055FF);
    font-size: 12px; font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
  }
  .upload-btn:hover {
    background: var(--color-text-accent, #0055FF);
    color: #fff;
  }
  .upload-btn svg { width: 14px; height: 14px; }

  /* ===== Controls ===== */
  .header-controls {
    display: flex; align-items: center; gap: 8px;
    margin-top: 14px; margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .filter-pills {
    display: flex; gap: 6px; flex: 1; flex-wrap: wrap;
  }
  .filter-pill {
    padding: 5px 12px;
    border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: 20px;
    background: transparent;
    color: var(--color-text-secondary, #737373);
    font-size: 12px; font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
    white-space: nowrap;
  }
  .filter-pill:hover {
    border-color: var(--color-text-accent, #0055FF);
    color: var(--color-text-accent, #0055FF);
  }
  .filter-pill.active {
    background: color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    border-color: var(--color-text-accent, #0055FF);
    color: var(--color-text-accent, #0055FF);
  }
  .filter-pill-count {
    font-size: 11px; opacity: 0.7; margin-left: 2px;
  }

  /* ===== Search ===== */
  .search-wrap { position: relative; flex: 0 0 auto; }
  .search-input {
    padding: 5px 28px 5px 12px;
    border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: 20px;
    font-size: 12px;
    width: 160px;
    background: var(--color-background-secondary, #ffffff);
    color: var(--color-text-primary, #171717);
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, width 0.2s ease;
  }
  .search-input:focus {
    border-color: var(--color-text-accent, #0055FF);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    width: 200px;
  }
  .search-input::placeholder {
    color: var(--color-text-secondary, #737373); opacity: 0.6;
  }
  .search-clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer;
    color: var(--color-text-secondary, #737373);
    font-size: 14px; line-height: 1; padding: 2px; display: none;
  }
  .search-clear.visible { display: block; }
  .search-clear:hover { color: var(--color-text-primary, #171717); }

  /* ===== Tag Chips ===== */
  .tag-bar {
    display: flex; gap: 6px; flex-wrap: wrap;
    padding: 0 20px 12px;
    flex-shrink: 0;
  }
  .tag-chip {
    padding: 3px 10px;
    border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: 14px;
    background: transparent;
    color: var(--color-text-secondary, #737373);
    font-size: 11px; font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .tag-chip:hover {
    border-color: var(--color-text-accent, #0055FF);
    color: var(--color-text-accent, #0055FF);
  }
  .tag-chip.active {
    background: color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    border-color: var(--color-text-accent, #0055FF);
    color: var(--color-text-accent, #0055FF);
  }

  /* ===== Content area ===== */
  .content {
    flex: 1; overflow-y: auto;
    padding: 0 20px 20px;
  }

  /* ===== File Grid ===== */
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    animation: fadeIn 0.2s ease;
  }
  .file-card {
    border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: var(--border-radius-sm, 0.5rem);
    background: var(--color-background-secondary, #ffffff);
    padding: 0;
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .file-card:hover {
    border-color: var(--color-text-accent, #0055FF);
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    transform: translateY(-1px);
  }
  .file-thumb {
    width: 100%; height: 120px;
    display: flex; align-items: center; justify-content: center;
    background: var(--color-background-primary, #faf9f7);
    overflow: hidden;
    flex-shrink: 0;
    color: var(--color-text-secondary, #737373);
  }
  .file-thumb img {
    width: 100%; height: 100%;
    object-fit: cover;
  }
  .file-info {
    padding: 10px 12px;
    flex: 1; display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .file-name {
    font-size: 13px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--color-text-primary, #171717);
  }
  .file-meta {
    font-size: 11px;
    color: var(--color-text-secondary, #737373);
    display: flex; gap: 8px; align-items: center;
  }
  .file-tags {
    display: flex; gap: 4px; flex-wrap: wrap;
    margin-top: 2px;
  }
  .file-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    color: var(--color-text-accent, #0055FF);
  }

  /* ===== Detail Panel ===== */
  .detail-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.3);
    z-index: 100;
    display: flex; align-items: center; justify-content: center;
    animation: fadeIn 0.15s ease;
  }
  .detail-panel {
    background: var(--color-background-secondary, #ffffff);
    border-radius: var(--border-radius-sm, 0.5rem);
    width: 90%; max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.15);
    animation: fadeIn 0.2s ease;
  }
  .detail-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding: 20px 20px 0;
  }
  .detail-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-size: 18px; font-weight: 500;
    letter-spacing: -0.025em;
    word-break: break-word;
    flex: 1; min-width: 0;
  }
  .detail-close {
    background: none; border: none; cursor: pointer;
    color: var(--color-text-secondary, #737373);
    font-size: 20px; line-height: 1; padding: 4px;
    flex-shrink: 0; margin-left: 12px;
  }
  .detail-close:hover { color: var(--color-text-primary, #171717); }
  .detail-preview {
    margin: 16px 20px;
    border-radius: var(--border-radius-sm, 0.5rem);
    overflow: hidden;
    background: var(--color-background-primary, #faf9f7);
    display: flex; align-items: center; justify-content: center;
    min-height: 120px;
    font-size: 56px;
  }
  .detail-preview img {
    max-width: 100%; max-height: 300px;
    object-fit: contain;
  }
  .detail-fields {
    padding: 0 20px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .detail-field {
    display: flex; flex-direction: column; gap: 2px;
  }
  .detail-label {
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--color-text-secondary, #737373);
  }
  .detail-value {
    font-size: 14px;
    color: var(--color-text-primary, #171717);
    word-break: break-all;
  }
  .detail-tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .detail-tag {
    font-size: 12px; padding: 2px 8px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    color: var(--color-text-accent, #0055FF);
  }
  .detail-actions {
    padding: 0 20px 20px;
    display: flex; gap: 8px;
  }
  .btn-danger {
    padding: 6px 16px;
    border: 1px solid color-mix(in srgb, var(--nb-color-danger, #dc2626) 40%, transparent);
    border-radius: 20px;
    background: transparent;
    color: var(--nb-color-danger, #dc2626);
    font-size: 12px; font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .btn-danger:hover {
    background: var(--nb-color-danger, #dc2626);
    color: #fff;
  }

  /* ===== Empty / Error States ===== */
  .empty-state {
    text-align: center; padding: 64px 24px;
    color: var(--color-text-secondary, #737373);
  }
  .empty-state-icon { margin-bottom: 12px; color: var(--color-text-secondary, #737373); }
  .empty-state-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-size: 16px; font-weight: 500;
    letter-spacing: -0.025em;
    margin-bottom: 6px;
    color: var(--color-text-primary, #171717);
  }
  .empty-state-desc { font-size: 13px; line-height: 1.5; }
  .loading-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .skel-card { height: 180px; border-radius: var(--border-radius-sm, 0.5rem); }
  .error-banner {
    padding: 10px 14px; margin: 0 0 12px;
    background: color-mix(in srgb, var(--nb-color-danger, #dc2626) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--nb-color-danger, #dc2626) 25%, transparent);
    border-radius: var(--border-radius-sm, 0.5rem);
    color: var(--nb-color-danger, #dc2626);
    font-size: 13px;
  }
</style>
</head>
<body>
<div id="app"></div>

<script>
(function() {
  "use strict";

  // =========================================================================
  // Bridge — postMessage JSON-RPC 2.0
  // =========================================================================

  var _pending = Object.create(null);
  var _rpcId = 0;

  function callTool(name, args) {
    return new Promise(function(resolve, reject) {
      var id = "files-" + (++_rpcId);
      _pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "tools/call",
        id: id,
        params: { name: name, arguments: args || {} }
      }, "*");
      setTimeout(function() {
        if (_pending[id]) {
          delete _pending[id];
          reject(new Error("Tool call timed out"));
        }
      }, 60000);
    });
  }

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

  function applyTokens(tokens) {
    if (!tokens || typeof tokens !== "object") return;
    var root = document.documentElement;
    for (var key in tokens) {
      if (tokens.hasOwnProperty(key)) {
        root.style.setProperty(key, tokens[key]);
      }
    }
  }

  // =========================================================================
  // State
  // =========================================================================

  var state = {
    files: [],
    totalCount: 0,
    allTags: [],
    activeFilter: "all",
    activeTag: null,
    searchQuery: "",
    loading: true,
    error: null,
    detailFile: null,
    deleting: false
  };

  var app = document.getElementById("app");
  var searchTimer = null;
  var apiBase = "";

  // =========================================================================
  // Message Handler
  // =========================================================================

  window.addEventListener("message", function(event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;

    // JSON-RPC response
    if (msg.jsonrpc === "2.0" && msg.id && _pending[msg.id]) {
      var p = _pending[msg.id];
      delete _pending[msg.id];
      if (msg.error) {
        p.reject(new Error(msg.error.message || "Tool call failed"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Host notifications
    if (msg.method === "ui/initialize") {
      if (msg.params) {
        if (msg.params.theme && msg.params.theme.tokens) {
          applyTokens(msg.params.theme.tokens);
        }
        if (msg.params.apiBase) {
          apiBase = msg.params.apiBase;
        }
      }
    }

    if (msg.method === "ui/notifications/host-context-changed") {
      var tokens = msg.params && msg.params.styles && msg.params.styles.variables;
      if (tokens) {
        applyTokens(tokens);
      }
    }

    if (msg.method === "synapse/data-changed") {
      loadFiles();
    }
  });

  // Signal readiness
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/ready", params: {} }, "*");

  // =========================================================================
  // Helpers
  // =========================================================================

  function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    var val = bytes / Math.pow(1024, i);
    return (i === 0 ? val : val.toFixed(1)) + " " + units[i];
  }

  // Lucide-style SVG icons (24x24 viewBox, stroke-based)
  var ICON = {
    file: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7Z"/><path d="M14 2v4a2 2 0 002 2h4"/></svg>',
    image: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 00-2.828 0L6 21"/></svg>',
    chart: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 002 2h16"/><path d="M7 16l4-8 4 4 4-10"/></svg>',
    type: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>',
    folder: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2Z"/></svg>',
  };

  function fileIcon(mimeType) {
    if (!mimeType) return ICON.file;
    if (mimeType.startsWith("image/")) return ICON.image;
    if (mimeType.startsWith("font/")) return ICON.type;
    if (mimeType === "text/csv" || mimeType === "application/json") return ICON.chart;
    if (mimeType.includes("spreadsheet") || mimeType.includes("xlsx")) return ICON.chart;
    return ICON.file;
  }

  function isImage(mimeType) {
    return mimeType && mimeType.startsWith("image/");
  }

  function relativeTime(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    var now = Date.now();
    var diff = Math.max(0, now - then);
    var secs = Math.floor(diff / 1000);
    if (secs < 60) return "Just now";
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return days + "d ago";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // =========================================================================
  // Type Filters
  // =========================================================================

  var typeFilters = [
    { key: "all", label: "All", match: function() { return true; } },
    { key: "images", label: "Images", match: function(f) { return f.mimeType && f.mimeType.startsWith("image/"); } },
    { key: "documents", label: "Documents", match: function(f) {
      if (!f.mimeType) return false;
      return f.mimeType === "application/pdf"
        || f.mimeType.includes("document")
        || f.mimeType.includes("docx")
        || f.mimeType.includes("word")
        || f.mimeType.includes("xlsx")
        || f.mimeType.includes("spreadsheet")
        || f.mimeType.startsWith("text/plain")
        || f.mimeType.startsWith("text/markdown");
    }},
    { key: "data", label: "Data", match: function(f) {
      if (!f.mimeType) return false;
      return f.mimeType === "text/csv"
        || f.mimeType === "application/json"
        || f.mimeType.includes("xml");
    }},
    { key: "fonts", label: "Fonts", match: function(f) {
      return f.mimeType && f.mimeType.startsWith("font/");
    }}
  ];

  function getFilteredFiles() {
    var filter = typeFilters.find(function(tf) { return tf.key === state.activeFilter; }) || typeFilters[0];
    var files = state.files.filter(filter.match);
    if (state.activeTag) {
      files = files.filter(function(f) {
        return f.tags && f.tags.indexOf(state.activeTag) !== -1;
      });
    }
    return files;
  }

  function collectTags(files) {
    var tagSet = {};
    for (var i = 0; i < files.length; i++) {
      var tags = files[i].tags || [];
      for (var j = 0; j < tags.length; j++) {
        tagSet[tags[j]] = (tagSet[tags[j]] || 0) + 1;
      }
    }
    var result = [];
    for (var tag in tagSet) {
      if (tagSet.hasOwnProperty(tag)) {
        result.push({ tag: tag, count: tagSet[tag] });
      }
    }
    result.sort(function(a, b) { return b.count - a.count; });
    return result;
  }

  // =========================================================================
  // Data Loading
  // =========================================================================

  function loadFiles() {
    state.loading = true;
    state.error = null;
    render();

    callTool("list", { limit: 200 })
      .then(function(result) {
        var data = parseResult(result);
        state.files = data.files || [];
        state.totalCount = data.total || 0;
        state.allTags = collectTags(state.files);
        state.loading = false;
        render();
      })
      .catch(function(err) {
        state.loading = false;
        state.error = err.message || "Failed to load files";
        render();
      });
  }

  function searchFiles(query) {
    state.loading = true;
    state.error = null;
    render();

    callTool("search", { query: query, limit: 100 })
      .then(function(result) {
        var data = parseResult(result);
        state.files = data.files || [];
        state.totalCount = data.total || 0;
        state.allTags = collectTags(state.files);
        state.loading = false;
        render();
      })
      .catch(function(err) {
        state.loading = false;
        state.error = err.message || "Search failed";
        render();
      });
  }

  function deleteFile(id) {
    state.deleting = true;
    render();

    callTool("delete", { id: id })
      .then(function() {
        state.detailFile = null;
        state.deleting = false;
        loadFiles();
      })
      .catch(function(err) {
        state.deleting = false;
        state.error = err.message || "Delete failed";
        state.detailFile = null;
        render();
      });
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  function render() {
    var html = "";
    var filtered = !state.loading ? getFilteredFiles() : [];

    // ── Header ──
    html += '<div class="header">';
    html += '<div class="header-top">';
    html += '<div>';
    html += '<div class="header-title">Files</div>';
    if (!state.loading && state.totalCount > 0) {
      html += '<div class="header-lede">' + state.totalCount + ' file' + (state.totalCount !== 1 ? 's' : '') + ' in workspace</div>';
    }
    html += '</div>';
    html += '<button class="upload-btn" id="uploadBtn" title="Upload coming soon">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
    html += 'Upload';
    html += '</button>';
    html += '</div>';

    // Filter pills + search
    html += '<div class="header-controls">';
    html += '<div class="filter-pills">';
    for (var i = 0; i < typeFilters.length; i++) {
      var tf = typeFilters[i];
      var isActive = state.activeFilter === tf.key;
      var count = 0;
      if (!state.loading) {
        var baseFiles = state.activeTag
          ? state.files.filter(function(f) { return f.tags && f.tags.indexOf(state.activeTag) !== -1; })
          : state.files;
        count = baseFiles.filter(tf.match).length;
      }
      if (tf.key !== "all" && count === 0 && !state.loading) continue;
      html += '<button class="filter-pill' + (isActive ? ' active' : '') + '" data-filter="' + tf.key + '">';
      html += esc(tf.label);
      if (!state.loading && count > 0) {
        html += '<span class="filter-pill-count"> ' + count + '</span>';
      }
      html += '</button>';
    }
    html += '</div>';

    html += '<div class="search-wrap">';
    html += '<input class="search-input" type="text" placeholder="Search files\\u2026" id="searchInput" />';
    html += '<button class="search-clear' + (state.searchQuery ? ' visible' : '') + '" id="searchClear" title="Clear">\\u00D7</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // ── Tag bar ──
    if (state.allTags.length > 0 && !state.loading) {
      html += '<div class="tag-bar">';
      for (var t = 0; t < state.allTags.length && t < 20; t++) {
        var tag = state.allTags[t];
        var tagActive = state.activeTag === tag.tag;
        html += '<button class="tag-chip' + (tagActive ? ' active' : '') + '" data-tag="' + esc(tag.tag) + '">';
        html += esc(tag.tag);
        html += '</button>';
      }
      html += '</div>';
    }

    // ── Content ──
    html += '<div class="content" id="contentArea">';

    if (state.error) {
      html += '<div class="error-banner">' + esc(state.error) + '</div>';
    }

    if (state.loading) {
      html += '<div class="loading-grid">';
      for (var s = 0; s < 8; s++) {
        html += '<div class="skel skel-card"></div>';
      }
      html += '</div>';
    } else if (filtered.length === 0) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2Z"/></svg></div>';
      if (state.searchQuery) {
        html += '<div class="empty-state-title">No files found</div>';
        html += '<div class="empty-state-desc">No files match \\u201C' + esc(state.searchQuery) + '\\u201D</div>';
      } else if (state.activeFilter !== "all" || state.activeTag) {
        html += '<div class="empty-state-title">No files match this filter</div>';
        html += '<div class="empty-state-desc">Try a different category or tag.</div>';
      } else {
        html += '<div class="empty-state-title">No files yet</div>';
        html += '<div class="empty-state-desc">Files created in conversations will appear here.</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="file-grid">';
      for (var fi = 0; fi < filtered.length; fi++) {
        var file = filtered[fi];
        html += renderFileCard(file);
      }
      html += '</div>';
    }

    html += '</div>';

    // ── Detail overlay ──
    if (state.detailFile) {
      html += renderDetailPanel(state.detailFile);
    }

    app.innerHTML = html;
    bindEvents();
  }

  function renderFileCard(file) {
    var html = '<div class="file-card" data-id="' + esc(file.id) + '">';

    // Thumbnail
    html += '<div class="file-thumb">';
    if (isImage(file.mimeType) && apiBase) {
      html += '<img src="' + esc(apiBase) + '/v1/files/' + esc(file.id) + '" alt="' + esc(file.filename) + '" loading="lazy" />';
    } else {
      html += fileIcon(file.mimeType);
    }
    html += '</div>';

    // Info
    html += '<div class="file-info">';
    html += '<div class="file-name" title="' + esc(file.filename) + '">' + esc(file.filename) + '</div>';
    html += '<div class="file-meta">';
    html += '<span>' + formatSize(file.size || 0) + '</span>';
    html += '<span>' + esc(relativeTime(file.createdAt)) + '</span>';
    html += '</div>';

    if (file.tags && file.tags.length > 0) {
      html += '<div class="file-tags">';
      for (var t = 0; t < file.tags.length && t < 3; t++) {
        html += '<span class="file-tag">' + esc(file.tags[t]) + '</span>';
      }
      if (file.tags.length > 3) {
        html += '<span class="file-tag">+' + (file.tags.length - 3) + '</span>';
      }
      html += '</div>';
    }

    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderDetailPanel(file) {
    var html = '<div class="detail-overlay" id="detailOverlay">';
    html += '<div class="detail-panel">';

    // Header
    html += '<div class="detail-header">';
    html += '<div class="detail-title">' + esc(file.filename) + '</div>';
    html += '<button class="detail-close" id="detailClose" title="Close">\\u00D7</button>';
    html += '</div>';

    // Preview
    html += '<div class="detail-preview">';
    if (isImage(file.mimeType) && apiBase) {
      html += '<img src="' + esc(apiBase) + '/v1/files/' + esc(file.id) + '" alt="' + esc(file.filename) + '" />';
    } else {
      html += fileIcon(file.mimeType);
    }
    html += '</div>';

    // Fields
    html += '<div class="detail-fields">';

    html += '<div class="detail-field">';
    html += '<div class="detail-label">ID</div>';
    html += '<div class="detail-value" style="font-family: monospace; font-size: 12px;">' + esc(file.id) + '</div>';
    html += '</div>';

    html += '<div class="detail-field">';
    html += '<div class="detail-label">Type</div>';
    html += '<div class="detail-value">' + esc(file.mimeType || 'Unknown') + '</div>';
    html += '</div>';

    html += '<div class="detail-field">';
    html += '<div class="detail-label">Size</div>';
    html += '<div class="detail-value">' + formatSize(file.size || 0) + '</div>';
    html += '</div>';

    html += '<div class="detail-field">';
    html += '<div class="detail-label">Created</div>';
    html += '<div class="detail-value">' + esc(file.createdAt ? new Date(file.createdAt).toLocaleString() : 'Unknown') + '</div>';
    html += '</div>';

    if (file.source) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Source</div>';
      html += '<div class="detail-value">' + esc(file.source) + '</div>';
      html += '</div>';
    }

    if (file.description) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Description</div>';
      html += '<div class="detail-value">' + esc(file.description) + '</div>';
      html += '</div>';
    }

    if (file.tags && file.tags.length > 0) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Tags</div>';
      html += '<div class="detail-tags">';
      for (var t = 0; t < file.tags.length; t++) {
        html += '<span class="detail-tag">' + esc(file.tags[t]) + '</span>';
      }
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';

    // Actions
    html += '<div class="detail-actions">';
    html += '<button class="btn-danger" id="deleteBtn"' + (state.deleting ? ' disabled' : '') + '>';
    html += state.deleting ? 'Deleting\\u2026' : 'Delete File';
    html += '</button>';
    html += '</div>';

    html += '</div>';
    html += '</div>';
    return html;
  }

  // =========================================================================
  // Event Binding
  // =========================================================================

  function bindEvents() {
    // Filter pills
    var pills = document.querySelectorAll(".filter-pill");
    for (var p = 0; p < pills.length; p++) {
      pills[p].addEventListener("click", function() {
        state.activeFilter = this.dataset.filter;
        render();
      });
    }

    // Tag chips
    var chips = document.querySelectorAll(".tag-chip");
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener("click", function() {
        var tag = this.dataset.tag;
        state.activeTag = state.activeTag === tag ? null : tag;
        render();
      });
    }

    // Search input
    var searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.value = state.searchQuery || "";
      searchInput.addEventListener("input", function() {
        var q = this.value;
        state.searchQuery = q;
        clearTimeout(searchTimer);

        if (!q.trim()) {
          loadFiles();
          return;
        }

        searchTimer = setTimeout(function() {
          searchFiles(q.trim());
        }, 300);
      });
      searchInput.addEventListener("keydown", function(e) {
        if (e.key === "Escape") {
          state.searchQuery = "";
          this.value = "";
          loadFiles();
        }
      });
    }

    // Search clear
    var clearBtn = document.getElementById("searchClear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function() {
        state.searchQuery = "";
        loadFiles();
      });
    }

    // Upload button — uses synapse/request-file protocol
    var uploadBtn = document.getElementById("uploadBtn");
    if (uploadBtn) {
      uploadBtn.addEventListener("click", function() {
        var reqId = "files-upload-" + (++_rpcId);
        _pending[reqId] = {
          resolve: function(result) {
            if (!result) return; // user cancelled
            var files = Array.isArray(result) ? result : [result];
            var chain = Promise.resolve();
            files.forEach(function(f) {
              chain = chain.then(function() {
                return callTool("write", {
                  filename: f.filename,
                  base64_data: f.base64Data,
                  mime_type: f.mimeType || "application/octet-stream",
                  tags: []
                });
              });
            });
            chain.then(function() { loadFiles(); })
              .catch(function(err) {
                state.error = "Upload failed: " + (err.message || err);
                render();
              });
          },
          reject: function(err) {
            state.error = "File picker failed: " + (err.message || err);
            render();
          }
        };
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "synapse/request-file",
          id: reqId,
          params: { multiple: true, maxSize: 26214400 }
        }, "*");
      });
    }

    // File card clicks
    var cards = document.querySelectorAll(".file-card");
    for (var fc = 0; fc < cards.length; fc++) {
      cards[fc].addEventListener("click", function() {
        var id = this.dataset.id;
        var file = state.files.find(function(f) { return f.id === id; });
        if (file) {
          state.detailFile = file;
          render();
        }
      });
    }

    // Detail overlay
    var overlay = document.getElementById("detailOverlay");
    if (overlay) {
      overlay.addEventListener("click", function(e) {
        if (e.target === overlay) {
          state.detailFile = null;
          render();
        }
      });
    }

    // Detail close
    var closeBtn = document.getElementById("detailClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", function() {
        state.detailFile = null;
        render();
      });
    }

    // Delete button
    var deleteBtn = document.getElementById("deleteBtn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function() {
        if (state.detailFile && !state.deleting) {
          if (confirm("Delete " + state.detailFile.filename + "? This cannot be undone.")) {
            deleteFile(state.detailFile.id);
          }
        }
      });
    }
  }

  // =========================================================================
  // Keyboard shortcut
  // =========================================================================

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && state.detailFile) {
      state.detailFile = null;
      render();
    }
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  loadFiles();

})();
</script>
</body>
</html>`;
