/**
 * MCP server entry point for @nimblebraininc/usage bundle.
 *
 * Delegates to the shared usage aggregator which reads conversation files
 * directly. No indexes, no separate log files — conversations are the
 * source of truth.
 *
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { aggregateUsage } from "../../../conversation/usage-aggregator.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const CONVERSATIONS_DIR = join(WORK_DIR, "conversations");

function log(msg: string): void {
  process.stderr.write(`[usage] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "report",
    description: "Get aggregated usage data (tokens, cost, tool calls) from conversation files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month", "all"],
          description: "Time period. Default: month.",
        },
        from: {
          type: "string",
          description: "Start date (YYYY-MM-DD). Overrides period.",
        },
        to: {
          type: "string",
          description: "End date (YYYY-MM-DD). Default: today.",
        },
        groupBy: {
          type: "string",
          enum: ["day", "conversation", "model"],
          description: "Group breakdown. Default: day.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
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
  h1 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 20px; font-weight: 600; }
  h2 { font-family: var(--nb-font-heading, Georgia, serif); font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; }
  select { padding: 7px 12px; border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: 0.5rem; font-size: 13px; background: var(--color-background-secondary, #ffffff); cursor: pointer; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: 0.75rem; padding: 16px; }
  .stat-value { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
  .stat-label { font-size: 11px; color: var(--color-text-secondary, #737373); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-detail { font-size: 11px; color: var(--color-text-secondary, #737373); margin-top: 6px; line-height: 1.6; }
  .stat-detail .row { display: flex; justify-content: space-between; }
  .section { margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; background: var(--color-background-secondary, #ffffff); border: 1px solid var(--color-border-primary, #e5e5e5); border-radius: 0.75rem; overflow: hidden; }
  th { text-align: left; padding: 10px 14px; font-size: 11px; font-weight: 600; color: var(--color-text-secondary, #737373); text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-background-primary, #faf9f7); border-bottom: 1px solid var(--color-border-primary, #e5e5e5); }
  th.right, td.right { text-align: right; }
  td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--color-background-tertiary, #f8f7f5); }
  tr:last-child td { border-bottom: none; }
  .empty { color: var(--color-text-secondary, #737373); text-align: center; padding: 32px; }
  .loading { color: var(--color-text-secondary, #737373); text-align: center; padding: 48px; }
</style>
</head>
<body>
<div id="app"><div class="loading">Loading usage data\u2026</div></div>
<script>
var _pending = {}, _rpcId = 0;
function callTool(name, args) {
  var server = "usage", tool = name, sep = name.indexOf("__");
  if (sep > 0) { server = name.substring(0, sep); tool = name.substring(sep + 2); }
  var id = "usage-" + (++_rpcId);
  return new Promise(function(resolve, reject) {
    _pending[id] = { resolve: resolve, reject: reject };
    window.parent.postMessage({ jsonrpc: "2.0", method: "tools/call", id: id, params: { server: server, name: tool, arguments: args || {} } }, "*");
    setTimeout(function() { if (_pending[id]) { delete _pending[id]; reject(new Error("Timed out")); } }, 60000);
  });
}
window.addEventListener("message", function(e) {
  var msg = e.data;
  if (!msg || !msg.jsonrpc || !msg.id || !_pending[msg.id]) return;
  var p = _pending[msg.id]; delete _pending[msg.id];
  msg.error ? p.reject(new Error(msg.error.message || "Failed")) : p.resolve(msg.result);
});

var app = document.getElementById("app");
function fmtCost(n) { return n < 0.01 ? "$" + (n*100).toFixed(2) + "c" : "$" + n.toFixed(2); }
function fmtCostP(n) { return "$" + n.toFixed(4); }
function fmtTok(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? Math.round(n/1e3)+"K" : String(n); }
function shortModel(m) { return m.replace(/^(anthropic:|openai:|google:)/,"").replace(/-\\d{8}$/,""); }

function render(data) {
  var t = data.totals || {}, tok = t.tokens || {}, cost = t.cost || {};
  var models = data.models || [], bd = data.breakdown || [];
  var totalTok = (tok.input||0) + (tok.output||0) + (tok.cacheRead||0);
  var modelRows = models.map(function(m) {
    return '<tr><td>'+shortModel(m.model)+'</td><td class="right">'+fmtTok((m.tokens.input||0)+(m.tokens.output||0)+(m.tokens.cacheRead||0))+'</td><td class="right">'+fmtCostP(m.cost.total)+'</td><td class="right">'+m.llmCalls+'</td></tr>';
  }).join("") || '<tr><td colspan="4" class="empty">No data</td></tr>';
  var bdRows = bd.map(function(d) {
    return '<tr><td>'+d.key+'</td><td class="right">'+fmtTok(d.tokens.input)+'</td><td class="right">'+fmtTok(d.tokens.output)+'</td><td class="right">'+fmtTok(d.tokens.cacheRead)+'</td><td class="right">'+fmtCostP(d.cost.total)+'</td><td class="right">'+d.llmCalls+'</td></tr>';
  }).join("") || '<tr><td colspan="6" class="empty">No data for this period</td></tr>';
  app.innerHTML =
    '<div class="page"><div class="header"><h1>Usage</h1><div class="controls"><select id="period"><option value="day">Today</option><option value="week" selected>Last 7 days</option><option value="month">This month</option><option value="all">All time</option></select><select id="groupBy"><option value="day" selected>By day</option><option value="model">By model</option><option value="conversation">By conversation</option></select></div></div>' +
    '<div class="stats-grid"><div class="stat"><div class="stat-value">'+fmtCost(cost.total||0)+'</div><div class="stat-label">Total Cost</div><div class="stat-detail"><div class="row"><span>Input</span><span>'+fmtCostP(cost.input||0)+'</span></div><div class="row"><span>Output</span><span>'+fmtCostP(cost.output||0)+'</span></div><div class="row"><span>Cache read</span><span>'+fmtCostP(cost.cacheRead||0)+'</span></div><div class="row"><span>Cache write</span><span>'+fmtCostP(cost.cacheCreation||0)+'</span></div></div></div>' +
    '<div class="stat"><div class="stat-value">'+fmtTok(totalTok)+'</div><div class="stat-label">Tokens</div><div class="stat-detail"><div class="row"><span>Input</span><span>'+fmtTok(tok.input||0)+'</span></div><div class="row"><span>Output</span><span>'+fmtTok(tok.output||0)+'</span></div><div class="row"><span>Cache read</span><span>'+fmtTok(tok.cacheRead||0)+'</span></div></div></div>' +
    '<div class="stat"><div class="stat-value">'+(t.llmCalls||0)+'</div><div class="stat-label">LLM Calls</div></div>' +
    '<div class="stat"><div class="stat-value">'+(t.conversations||0)+'</div><div class="stat-label">Conversations</div></div></div>' +
    '<div class="section"><h2>By Model</h2><table><thead><tr><th>Model</th><th class="right">Tokens</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>'+modelRows+'</tbody></table></div>' +
    '<div class="section"><h2>Breakdown</h2><table><thead><tr><th>Date</th><th class="right">Input</th><th class="right">Output</th><th class="right">Cache</th><th class="right">Cost</th><th class="right">Calls</th></tr></thead><tbody>'+bdRows+'</tbody></table></div></div>';
  document.getElementById("period").addEventListener("change", function() { load(); });
  document.getElementById("groupBy").addEventListener("change", function() { load(); });
}
function load() {
  var p = document.getElementById("period") ? document.getElementById("period").value : "week";
  var g = document.getElementById("groupBy") ? document.getElementById("groupBy").value : "day";
  callTool("usage__report", { period: p, groupBy: g }).then(function(d) { if (d) render(d); }).catch(function(e) {
    app.innerHTML = '<div class="page"><div class="empty">Failed: '+(e.message||e)+'</div></div>';
  });
}
load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting — conversations dir: ${CONVERSATIONS_DIR}`);

  const server = new Server(
    { name: "@nimblebraininc/usage", version: "0.3.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "report") {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
        ],
        isError: true,
      };
    }

    try {
      const period = (args?.period as string) ?? "month";
      const groupBy = (args?.groupBy as string) ?? "day";
      const from = args?.from as string | undefined;
      const to = args?.to as string | undefined;
      const result = await aggregateUsage(CONVERSATIONS_DIR, period, groupBy, from, to);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool error (${name}): ${message}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "ui://usage/dashboard", name: "Usage Dashboard", mimeType: "text/html" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://usage/dashboard") {
      return {
        contents: [{ uri: request.params.uri, mimeType: "text/html", text: DASHBOARD_HTML }],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server connected via stdio");

  const shutdown = async () => {
    log("Shutting down...");
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
