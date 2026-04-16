/**
 * Usage dashboard HTML — extracted from the former @nimblebraininc/usage MCP server bundle.
 * Served as a ui:// resource at `usage/dashboard`.
 */

export const USAGE_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Usage</title>
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
  #app { height: 100%; width: 100%; overflow-y: auto; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--color-border-primary, #e5e5e5); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--color-text-secondary, #737373); }

  .page { padding: 32px; max-width: 960px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; color: var(--color-text-primary, #171717); }
  h2 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 16px; font-weight: 600; color: var(--color-text-primary, #171717); margin-bottom: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; }
  select { padding: 7px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.5rem); font-size: 13px; background: var(--color-background-secondary, #ffffff); color: var(--color-text-primary, #171717); cursor: pointer; }
  select:focus { outline: none; border-color: var(--color-ring-primary, #0055FF); box-shadow: 0 0 0 2px rgba(0,85,255,.15); }

  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.75rem); padding: 16px; }
  .stat-value { font-size: 24px; font-weight: 700; color: var(--color-text-primary, #171717); letter-spacing: -0.5px; }
  .stat-label { font-size: 11px; color: var(--color-text-secondary, #737373); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-detail { font-size: 11px; color: var(--color-text-secondary, #737373); margin-top: 6px; line-height: 1.6; }
  .stat-detail .row { display: flex; justify-content: space-between; }
  .stat-detail .label { opacity: 0.7; }

  .section { margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: var(--border-radius-sm, 0.75rem); overflow: hidden; }
  th { text-align: left; padding: 10px 14px; font-size: 11px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-background-primary, #faf9f7); border-bottom: 1px solid var(--color-border-primary, #e5e5e5); }
  th.right, td.right { text-align: right; }
  td { padding: 10px 14px; font-size: 13px; color: var(--color-text-primary, #171717); border-bottom: 1px solid var(--color-background-tertiary, #f8f7f5); }
  tr:last-child td { border-bottom: none; }
  .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 32px; }
  .loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px; }
  .muted { color: var(--color-text-secondary, #737373); }
</style>
</head>
<body>
<div id="app"><div class="loading">Loading usage data\u2026</div></div>
<script>
var _pending = {};
var _rpcId = 0;

function callTool(name, args) {
  var server = "usage";
  var tool = name;
  var sep = name.indexOf("__");
  if (sep > 0) { server = name.substring(0, sep); tool = name.substring(sep + 2); }
  var id = "usage-" + (++_rpcId);
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

var app = document.getElementById("app");

function parseToolResult(data) {
  if (!data) return null;
  // If data already has totals, it's already parsed (structuredContent path)
  if (data.totals) return data;
  // Extract from structuredContent if present
  if (data.structuredContent && data.structuredContent.totals) return data.structuredContent;
  // Extract from content array (CallToolResult text envelope)
  if (Array.isArray(data.content)) {
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === "text" && data.content[i].text) {
        try { return JSON.parse(data.content[i].text); } catch(e) { return null; }
      }
    }
  }
  // Try parsing data itself as a string
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch(e) { return null; }
  }
  return null;
}

function fmt(n) { return n.toLocaleString(); }
function fmtCost(n) { return n < 0.01 ? "$" + (n * 100).toFixed(2) + "c" : "$" + n.toFixed(2); }
function fmtCostPrecise(n) { return "$" + n.toFixed(4); }
function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}
function shortModel(m) {
  return m.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\\d{8}$/, "");
}

function render(data) {
  var t = data.totals || {};
  var tokens = t.tokens || {};
  var cost = t.cost || {};
  var models = data.models || [];
  var breakdown = data.breakdown || [];
  var totalTokens = (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0);

  var modelRows = models.map(function(m) {
    var mt = (m.tokens.input || 0) + (m.tokens.output || 0) + (m.tokens.cacheRead || 0);
    return '<tr><td>' + shortModel(m.model) + '</td>'
      + '<td class="right">' + fmtTokens(mt) + '</td>'
      + '<td class="right">' + fmtCostPrecise(m.cost.total) + '</td>'
      + '<td class="right">' + m.llmCalls + '</td></tr>';
  }).join("") || '<tr><td colspan="4" class="empty">No data</td></tr>';

  var groupLabel = document.getElementById("groupBy") ? document.getElementById("groupBy").value : "day";
  var breakdownRows = breakdown.map(function(d) {
    var bt = (d.tokens.input || 0) + (d.tokens.output || 0) + (d.tokens.cacheRead || 0);
    return '<tr><td>' + d.key + '</td>'
      + '<td class="right">' + fmtTokens(d.tokens.input) + '</td>'
      + '<td class="right">' + fmtTokens(d.tokens.output) + '</td>'
      + '<td class="right">' + fmtTokens(d.tokens.cacheRead) + '</td>'
      + '<td class="right">' + fmtCostPrecise(d.cost.total) + '</td>'
      + '<td class="right">' + d.llmCalls + '</td></tr>';
  }).join("") || '<tr><td colspan="6" class="empty">No data for this period</td></tr>';

  app.innerHTML =
    '<div class="page">' +
    '<div class="header"><h1>Usage</h1>' +
    '<div class="controls">' +
    '<select id="period">' +
    '<option value="day">Today</option>' +
    '<option value="week" selected>Last 7 days</option>' +
    '<option value="month">This month</option>' +
    '<option value="all">All time</option>' +
    '</select>' +
    '<select id="groupBy">' +
    '<option value="day" selected>By day</option>' +
    '<option value="model">By model</option>' +
    '<option value="conversation">By conversation</option>' +
    '</select>' +
    '</div></div>' +

    '<div class="stats-grid">' +
    '<div class="stat"><div class="stat-value">' + fmtCost(cost.total || 0) + '</div><div class="stat-label">Total Cost</div>' +
    '<div class="stat-detail">' +
    '<div class="row"><span class="label">Input</span><span>' + fmtCostPrecise(cost.input || 0) + '</span></div>' +
    '<div class="row"><span class="label">Output</span><span>' + fmtCostPrecise(cost.output || 0) + '</span></div>' +
    '<div class="row"><span class="label">Cache read</span><span>' + fmtCostPrecise(cost.cacheRead || 0) + '</span></div>' +
    '<div class="row"><span class="label">Cache write</span><span>' + fmtCostPrecise(cost.cacheCreation || 0) + '</span></div>' +
    '</div></div>' +

    '<div class="stat"><div class="stat-value">' + fmtTokens(totalTokens) + '</div><div class="stat-label">Total Tokens</div>' +
    '<div class="stat-detail">' +
    '<div class="row"><span class="label">Input</span><span>' + fmtTokens(tokens.input || 0) + '</span></div>' +
    '<div class="row"><span class="label">Output</span><span>' + fmtTokens(tokens.output || 0) + '</span></div>' +
    '<div class="row"><span class="label">Cache read</span><span>' + fmtTokens(tokens.cacheRead || 0) + '</span></div>' +
    '</div></div>' +

    '<div class="stat"><div class="stat-value">' + (t.llmCalls || 0) + '</div><div class="stat-label">LLM Calls</div></div>' +

    '<div class="stat"><div class="stat-value">' + (t.conversations || 0) + '</div><div class="stat-label">Conversations</div></div>' +

    '</div>' +

    '<div class="section"><h2>By Model</h2>' +
    '<table><thead><tr><th>Model</th><th class="right">Tokens</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>' + modelRows + '</tbody></table></div>' +

    '<div class="section"><h2>Breakdown</h2>' +
    '<table><thead><tr><th>' + (groupLabel === "day" ? "Date" : groupLabel === "model" ? "Model" : "Conversation") + '</th><th class="right">Input</th><th class="right">Output</th><th class="right">Cache</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>' + breakdownRows + '</tbody></table></div>' +

    '</div>';

  document.getElementById("period").addEventListener("change", function() { load(); });
  document.getElementById("groupBy").addEventListener("change", function() { load(); });
}

function load() {
  var period = document.getElementById("period") ? document.getElementById("period").value : "week";
  var groupBy = document.getElementById("groupBy") ? document.getElementById("groupBy").value : "day";
  callTool("usage__report", { period: period, groupBy: groupBy }).then(function(data) {
    var parsed = parseToolResult(data);
    if (parsed) render(parsed);
    else app.innerHTML = '<div class="page"><div class="empty">No usage data returned</div></div>';
  }).catch(function(err) {
    app.innerHTML = '<div class="page"><div class="empty">Failed to load: ' + (err.message || err) + '</div></div>';
  });
}
load();
</script>
</body>
</html>`;
