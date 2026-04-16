/**
 * Self-contained HTML/CSS/JS for the conversations browser.
 *
 * Served as an MCP resource at ui://conversations/browser.
 * Rendered in a platform iframe with the postMessage bridge for tool calls.
 *
 * All CSS uses ext-apps spec tokens and NB extension tokens injected by the platform. No external resources.
 */

export const BROWSER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conversations</title>
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
  #app { height: 100%; width: 100%; overflow-y: auto; display: flex; flex-direction: column; }

  /* ===== Utility ===== */
  .serif {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    letter-spacing: -0.025em;
  }

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

  /* ===== Header ===== */
  .header {
    position: sticky; top: 0; z-index: 10;
    background: var(--color-background-primary, #faf9f7);
    padding: 20px 20px 0;
    flex-shrink: 0;
    max-width: 720px;
    margin: 0 auto;
    width: 100%;
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
    font-size: 11px;
    opacity: 0.7;
    margin-left: 2px;
  }
  .search-wrap {
    position: relative;
    flex: 0 0 auto;
  }
  .search-input {
    padding: 5px 28px 5px 12px;
    border: 1px solid var(--color-border-primary, #e5e5e5);
    border-radius: 20px;
    font-size: 12px;
    width: 140px;
    background: var(--color-background-secondary, #ffffff);
    color: var(--color-text-primary, #171717);
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, width 0.2s ease;
  }
  .search-input:focus {
    border-color: var(--color-text-accent, #0055FF);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-text-accent, #0055FF) 8%, transparent);
    width: 180px;
  }
  .search-input::placeholder {
    color: var(--color-text-secondary, #737373);
    opacity: 0.6;
  }
  .search-clear {
    position: absolute;
    right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer;
    color: var(--color-text-secondary, #737373);
    font-size: 14px; line-height: 1;
    padding: 2px;
    display: none;
  }
  .search-clear.visible { display: block; }
  .search-clear:hover { color: var(--color-text-primary, #171717); }

  /* ===== Content area ===== */
  .content {
    flex: 1; overflow-y: auto;
    padding: 0 20px 20px;
    max-width: 720px;
    margin: 0 auto;
    width: 100%;
    transition: opacity 0.2s ease;
  }
  .content.transitioning { opacity: 0; }

  /* ===== Temporal Section Labels ===== */
  .section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-secondary, #737373);
    padding: 24px 0 8px;
  }
  .section-label:first-child { padding-top: 8px; }

  /* ===== Conversation List Item ===== */
  .conv-item {
    padding: 14px 0;
    border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
    cursor: pointer;
    transition: transform 0.15s ease;
  }
  .conv-item:last-child { border-bottom: none; }
  .conv-item:hover { transform: translateX(2px); }
  .conv-item:hover .conv-title { color: var(--color-text-accent, #0055FF); }
  .conv-item-top {
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  }
  .conv-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.025em;
    line-height: 1.45;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
    transition: color 0.15s ease;
  }
  .conv-time {
    font-size: 12px;
    color: var(--color-text-secondary, #737373);
    flex-shrink: 0;
  }
  .conv-preview {
    margin-top: 4px; font-size: 13px;
    color: var(--color-text-secondary, #737373);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    line-height: 1.4;
  }

  /* ===== Empty / Loading States ===== */
  .empty-state {
    text-align: center; padding: 64px 24px;
    color: var(--color-text-secondary, #737373);
  }
  .empty-state-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-size: 16px; font-weight: 500;
    letter-spacing: -0.025em;
    margin-bottom: 6px;
    color: var(--color-text-primary, #171717);
  }
  .empty-state-desc { font-size: 13px; line-height: 1.5; }
  .loading-skels { padding: 0 4px; }
  .skel-card { height: 52px; margin-bottom: 12px; border-radius: var(--border-radius-sm, 0.5rem); }

  /* ===== Search Results ===== */
  .search-result {
    padding: 14px 0;
    border-bottom: 1px solid var(--color-border-primary, #e5e5e5);
    cursor: pointer;
    transition: transform 0.15s ease;
  }
  .search-result:last-child { border-bottom: none; }
  .search-result:hover { transform: translateX(2px); }
  .search-result-title {
    font-family: var(--nb-font-heading, Georgia, 'Times New Roman', serif);
    font-weight: 500; margin-bottom: 4px;
    letter-spacing: -0.025em;
  }
  .search-result-snippet {
    font-size: 13px; color: var(--color-text-secondary, #737373);
    line-height: 1.5; margin-bottom: 4px;
    overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .search-result-snippet mark {
    background: color-mix(in srgb, var(--nb-color-warning, #f59e0b) 30%, transparent);
    color: inherit; padding: 0 1px; border-radius: 2px;
  }
  .search-results-count {
    font-size: 12px; color: var(--color-text-secondary, #737373);
    padding: 0 2px 8px;
  }

  /* ===== Error banner ===== */
  .error-banner {
    padding: 10px 14px; margin: 0 0 8px;
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
      var id = "conv-" + (++_rpcId);
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

  function emitAction(action, params) {
    window.parent.postMessage({ method: "synapse/action", params: Object.assign({ action: action }, params || {}) }, "*");
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

  // Listen for JSON-RPC responses and host notifications
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
      if (msg.params && msg.params.theme && msg.params.theme.tokens) {
        applyTokens(msg.params.theme.tokens);
      }
    }

    if (msg.method === "ui/notifications/host-context-changed") {
      var tokens = msg.params && msg.params.styles && msg.params.styles.variables;
      if (tokens) {
        applyTokens(tokens);
      }
    }

    if (msg.method === "synapse/data-changed") {
      if (state.view === "list" || state.view === "search") {
        loadList();
      }
    }
  });

  // Signal readiness
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/ready", params: {} }, "*");

  // =========================================================================
  // State
  // =========================================================================

  var state = {
    view: "list",          // "list" | "search"
    conversations: [],
    totalCount: 0,
    nextCursor: null,
    searchQuery: "",
    searchResults: null,
    activeFilter: "all",   // "all" | "today" | "yesterday" | "week" | "earlier"
    loading: true,
    error: null
  };

  var app = document.getElementById("app");
  var debounceTimer = null;

  // =========================================================================
  // Helpers
  // =========================================================================

  function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
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
    if (days < 30) return Math.floor(days / 7) + "w ago";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function truncate(s, max) {
    if (!s) return "";
    return s.length > max ? s.slice(0, max) + "\\u2026" : s;
  }

  // =========================================================================
  // Temporal Grouping
  // =========================================================================

  function groupByDate(conversations) {
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    var startOfWeek = new Date(startOfToday.getTime() - 7 * 86400000);

    var groups = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "This Week", items: [] },
      { label: "Earlier", items: [] }
    ];

    for (var i = 0; i < conversations.length; i++) {
      var c = conversations[i];
      var d = new Date(c.updatedAt || c.createdAt || 0);
      if (d >= startOfToday) groups[0].items.push(c);
      else if (d >= startOfYesterday) groups[1].items.push(c);
      else if (d >= startOfWeek) groups[2].items.push(c);
      else groups[3].items.push(c);
    }

    return groups;
  }

  // =========================================================================
  // View Transitions
  // =========================================================================

  function transitionView(callback) {
    var content = document.getElementById("contentArea");
    if (!content) { callback(); return; }
    content.classList.add("transitioning");
    setTimeout(function() {
      callback();
      var newContent = document.getElementById("contentArea");
      if (newContent) newContent.classList.remove("transitioning");
    }, 200);
  }

  // =========================================================================
  // Data Loading
  // =========================================================================

  function loadList(search) {
    state.loading = true;
    state.error = null;
    render();

    var args = {};
    if (search) args.search = search;

    callTool("list", args)
      .then(function(result) {
        var data = parseResult(result);
        state.conversations = data.conversations || [];
        state.totalCount = data.totalCount || 0;
        state.nextCursor = data.nextCursor || null;
        state.loading = false;
        render();
      })
      .catch(function(err) {
        state.loading = false;
        state.error = err.message || "Failed to load conversations";
        render();
      });
  }

  function deepSearch(query) {
    if (!query || !query.trim()) return;
    state.view = "search";
    state.searchQuery = query.trim();
    state.searchResults = null;
    state.loading = true;
    state.error = null;
    render();

    callTool("search", { query: state.searchQuery })
      .then(function(result) {
        var data = parseResult(result);
        state.searchResults = data;
        state.loading = false;
        render();
      })
      .catch(function(err) {
        state.loading = false;
        state.error = err.message || "Search failed";
        render();
      });
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  // Filter config: "week" includes today+yesterday+thisWeek (cumulative)
  var filterGroups = {
    all: [0, 1, 2, 3],
    today: [0],
    yesterday: [1],
    week: [0, 1, 2],
    earlier: [3]
  };
  var filterLabels = [
    { key: "all", label: "All" },
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "week", label: "This Week" },
    { key: "earlier", label: "Earlier" }
  ];

  function render() {
    var html = "";
    var groups = !state.loading ? groupByDate(state.conversations) : [];
    var totalCount = state.conversations.length;
    var isSearching = state.view === "search";
    var hasQuery = state.searchQuery && state.searchQuery.trim();

    // ── Header (always visible) ──
    html += '<div class="header">';
    html += '<div class="header-title">Conversations</div>';
    if (!state.loading && totalCount > 0) {
      html += '<div class="header-lede">You have ' + totalCount + ' conversation' + (totalCount !== 1 ? 's' : '') + '</div>';
    }

    // Filter pills + inline search
    html += '<div class="header-controls">';
    html += '<div class="filter-pills">';
    for (var f = 0; f < filterLabels.length; f++) {
      var fl = filterLabels[f];
      var isActive = !isSearching && state.activeFilter === fl.key;
      var pillIndices = filterGroups[fl.key] || [];
      var pillCount = 0;
      for (var pi = 0; pi < pillIndices.length; pi++) {
        pillCount += groups[pillIndices[pi]] ? groups[pillIndices[pi]].items.length : 0;
      }
      if (fl.key !== "all" && pillCount === 0 && !state.loading) continue;
      html += '<button class="filter-pill' + (isActive ? ' active' : '') + '" data-filter="' + fl.key + '">';
      html += esc(fl.label);
      if (!state.loading && pillCount > 0) {
        html += '<span class="filter-pill-count"> ' + pillCount + '</span>';
      }
      html += '</button>';
    }
    html += '</div>';

    // Inline search input
    html += '<div class="search-wrap">';
    html += '<input class="search-input" type="text" placeholder="Search\\u2026" id="searchInput" />';
    html += '<button class="search-clear' + (hasQuery ? ' visible' : '') + '" id="searchClear" title="Clear search">\\u00D7</button>';
    html += '</div>';

    html += '</div>';
    html += '</div>';

    // ── Content area ──
    html += '<div class="content" id="contentArea">';

    if (state.error) {
      html += '<div class="error-banner">' + esc(state.error) + '</div>';
    }

    if (isSearching) {
      html += renderSearchContent();
    } else {
      html += renderListContent(groups);
    }

    html += '</div>';
    app.innerHTML = html;
    bindEvents();
  }

  function renderListContent(groups) {
    var html = "";

    if (state.loading) {
      html += '<div class="loading-skels">';
      for (var i = 0; i < 6; i++) {
        html += '<div class="skel skel-card"></div>';
      }
      html += '</div>';
      return html;
    }

    if (state.conversations.length === 0) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state-title">What would you like to explore?</div>';
      html += '<div class="empty-state-desc">Start a conversation to see your history here.</div>';
      html += '</div>';
      return html;
    }

    var activeIndices = filterGroups[state.activeFilter] || filterGroups.all;
    var showSectionLabels = activeIndices.length > 1;
    var hasVisible = false;

    for (var g = 0; g < activeIndices.length; g++) {
      var group = groups[activeIndices[g]];
      if (!group || group.items.length === 0) continue;
      hasVisible = true;

      if (showSectionLabels) {
        html += '<div class="section-label">' + esc(group.label) + '</div>';
      }

      for (var j = 0; j < group.items.length; j++) {
        var c = group.items[j];
        var title = c.title || c.preview || c.id;

        html += '<div class="conv-item" data-id="' + esc(c.id) + '">';
        html += '<div class="conv-item-top">';
        html += '<span class="conv-title">' + esc(truncate(title, 80)) + '</span>';
        html += '<span class="conv-time">' + esc(relativeTime(c.updatedAt || c.createdAt)) + '</span>';
        html += '</div>';
        if (c.preview) {
          html += '<div class="conv-preview">' + esc(truncate(c.preview, 120)) + '</div>';
        }
        html += '</div>';
      }
    }

    if (!hasVisible) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state-desc">No conversations in this period.</div>';
      html += '</div>';
    }

    return html;
  }

  function renderSearchContent() {
    var html = "";

    if (state.loading) {
      html += '<div class="loading-skels">';
      for (var i = 0; i < 4; i++) {
        html += '<div class="skel skel-card"></div>';
      }
      html += '</div>';
      return html;
    }

    if (!state.searchResults) return html;

    var results = state.searchResults.results || [];
    html += '<div class="search-results-count">';
    html += results.length + ' result' + (results.length !== 1 ? 's' : '') + ' for \\u201C' + esc(state.searchQuery) + '\\u201D';
    html += '</div>';

    if (results.length === 0) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state-title">Nothing found</div>';
      html += '<div class="empty-state-desc">No conversations match \\u201C' + esc(state.searchQuery) + '\\u201D</div>';
      html += '</div>';
    } else {
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        html += '<div class="search-result" data-id="' + esc(r.id) + '">';
        html += '<div class="search-result-title">' + esc(r.title || r.id) + '</div>';
        if (r.matches && r.matches.length > 0) {
          for (var k = 0; k < r.matches.length; k++) {
            var snippet = r.matches[k].snippet || "";
            html += '<div class="search-result-snippet">' + highlightQuery(snippet, state.searchQuery) + '</div>';
          }
        }
        html += '</div>';
      }
    }

    return html;
  }

  function bindEvents() {
    // Filter pills
    var pills = document.querySelectorAll(".filter-pill");
    for (var p = 0; p < pills.length; p++) {
      pills[p].addEventListener("click", function() {
        state.activeFilter = this.dataset.filter;
        if (state.view === "search") {
          state.view = "list";
          state.searchQuery = "";
          state.searchResults = null;
        }
        render();
      });
    }

    // Search input
    var searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.value = state.searchQuery || "";
      searchInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var q = searchInput.value.trim();
          if (q) deepSearch(q);
        }
        if (e.key === "Escape") {
          clearSearch();
        }
      });
      searchInput.addEventListener("input", onSearchInput);
    }

    // Clear button
    var clearBtn = document.getElementById("searchClear");
    if (clearBtn) {
      clearBtn.addEventListener("click", clearSearch);
    }

    // Content click — conversations or search results
    var contentArea = document.getElementById("contentArea");
    if (contentArea) {
      contentArea.addEventListener("click", function(e) {
        var item = e.target.closest(".conv-item") || e.target.closest(".search-result");
        if (item && item.dataset.id) {
          emitAction("openConversation", { id: item.dataset.id });
        }
      });
    }
  }

  function clearSearch() {
    state.searchQuery = "";
    state.searchResults = null;
    state.view = "list";
    render();
    var si = document.getElementById("searchInput");
    if (si) si.focus();
  }

  function highlightQuery(text, query) {
    if (!query) return esc(text);
    var escaped = esc(text);
    var qEsc = esc(query);
    var lower = escaped.toLowerCase();
    var qLower = qEsc.toLowerCase();
    var idx = lower.indexOf(qLower);
    if (idx === -1) return escaped;

    var before = escaped.slice(0, idx);
    var match = escaped.slice(idx, idx + qEsc.length);
    var after = escaped.slice(idx + qEsc.length);
    return before + "<mark>" + match + "</mark>" + after;
  }

  // =========================================================================
  // Search input handler
  // =========================================================================

  function onSearchInput(e) {
    var q = e.target.value;
    state.searchQuery = q;

    // If user clears the search box, return to full list
    if (!q.trim() && state.view === "search") {
      state.view = "list";
      loadList();
    }
  }

  // =========================================================================
  // Initial load
  // =========================================================================

  loadList();

})();
</script>
</body>
</html>`;
