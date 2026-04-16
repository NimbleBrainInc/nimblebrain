import { BRIDGE_HELPER } from "./_bridge.ts";

export const USAGE_DASHBOARD_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");

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
    return '<tr><td>' + shortModel(m.model) + '</td>'
      + '<td class="right">' + fmtCostPrecise(m.cost.total) + '</td>'
      + '<td class="right">' + m.llmCalls + '</td></tr>';
  }).join("") || '<tr><td colspan="3" class="empty">No data</td></tr>';

  var breakdownRows = breakdown.map(function(d) {
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
    '<select id="period"><option value="day">Today</option><option value="week" selected>Last 7 days</option><option value="month">This month</option><option value="all">All time</option></select>' +
    '</div></div>' +

    '<div class="stats-grid">' +
    '<div class="stat"><div class="stat-value">' + fmtCost(cost.total || 0) + '</div><div class="stat-label">Cost</div>' +
    '<div class="stat-detail">' +
    '<div class="row"><span class="label">Input</span><span>' + fmtCostPrecise(cost.input || 0) + '</span></div>' +
    '<div class="row"><span class="label">Output</span><span>' + fmtCostPrecise(cost.output || 0) + '</span></div>' +
    '<div class="row"><span class="label">Cache</span><span>' + fmtCostPrecise(cost.cacheRead || 0) + '</span></div>' +
    '</div></div>' +
    '<div class="stat"><div class="stat-value">' + fmtTokens(totalTokens) + '</div><div class="stat-label">Tokens</div></div>' +
    '<div class="stat"><div class="stat-value">' + (t.llmCalls || 0) + '</div><div class="stat-label">LLM Calls</div></div>' +
    '</div>' +

    '<div class="section"><h2>By Model</h2>' +
    '<table><thead><tr><th>Model</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>' + modelRows + '</tbody></table></div>' +

    '<div class="section"><h2>Daily Breakdown</h2>' +
    '<table><thead><tr><th>Date</th><th class="right">Input</th><th class="right">Output</th><th class="right">Cache</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>' + breakdownRows + '</tbody></table></div>' +

    '</div>';

  document.getElementById("period").addEventListener("change", (e) => load(e.target.value));
}

render({});

async function load(period) {
  period = period || "week";
  const result = await callTool("usage__report", { period, groupBy: "day" });
  const data = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result;
  if (data) render(data);
}
load("week");
`;
