import { BRIDGE_HELPER } from "./_bridge.ts";

export const USAGE_BAR_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");

function fmtCost(n) { return n < 0.01 ? "$" + (n * 100).toFixed(2) + "c" : "$" + n.toFixed(2); }
function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

function render(data) {
  var t = data.totals || data;
  var tokens = t.tokens || {};
  var cost = t.cost || {};
  var totalTokens = (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0);
  var totalCost = cost.total || t.totalCost || 0;
  app.innerHTML =
    '<div class="bar">' +
    '<span class="metric"><span class="label">Cost:</span> <span class="value">' + fmtCost(totalCost) + '</span></span>' +
    '<span class="metric"><span class="label">Tokens:</span> <span class="value">' + fmtTokens(totalTokens) + '</span></span>' +
    '<span class="metric"><span class="label">Calls:</span> <span class="value">' + (t.llmCalls || 0) + '</span></span>' +
    '</div>';
}

render({ totalCost: 0 });

window.addEventListener("message", (e) => {
  if (e.data?.method === "ui/initialize" && e.data.params?.usage) {
    render(e.data.params.usage);
  }
});

async function load() {
  try {
    const result = await callTool("usage_summary", {});
    const data = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result;
    if (data) render(data);
  } catch (_) { /* ok — initialize message will update */ }
}
load();
`;
