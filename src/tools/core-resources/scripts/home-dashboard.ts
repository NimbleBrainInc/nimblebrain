import { BRIDGE_HELPER } from "./_bridge.ts";

export const HOME_DASHBOARD_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");

// --- Markdown helpers ---
function md(text) {
  if (!text) return "";
  return text
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>");
}

// --- Status dot color (reads NB extension tokens, falls back to hardcoded) ---
function dotColor(sentiment) {
  var root = getComputedStyle(document.documentElement);
  if (sentiment === "positive") return root.getPropertyValue("--nb-color-success").trim() || "#059669";
  if (sentiment === "warning") return root.getPropertyValue("--nb-color-danger").trim() || "#dc2626";
  return root.getPropertyValue("--nb-color-warning").trim() || "#f59e0b";
}

// --- Skeleton loading state ---
function showSkeleton() {
  app.innerHTML =
    '<div class="page">' +
    '<div class="skel skel-greeting"></div>' +
    '<div class="skel skel-date"></div>' +
    '<div class="skel skel-lede"></div>' +
    '<div class="skel skel-divider"></div>' +
    '<div class="skel skel-item"></div>' +
    '<div class="skel skel-item"></div>' +
    '<div class="skel skel-divider"></div>' +
    '<div class="skel skel-item"></div>' +
    '<div class="skel skel-item"></div>' +
    '<div class="skel skel-item"></div>' +
    '</div>';
}

// --- Error state ---
function showError(message) {
  app.innerHTML =
    '<div class="page">' +
    '<div class="error-box">' +
    '<p>' + (message || "Something went wrong loading your briefing.") + '</p>' +
    '<button class="retry-btn" onclick="loadBriefing()">Retry</button>' +
    '</div></div>';
}

// --- Render briefing ---
function renderBriefing(data) {
  var html = '<div class="page">';

  // Refresh banner (hidden by default)
  html += '<div class="refresh-banner" id="refresh-banner">' +
    '<span>New activity available</span>' +
    '<button onclick="loadBriefing(true)">Refresh</button>' +
    '</div>';

  // Greeting + date
  html += '<div class="greeting">' + (data.greeting || "Hello") + '</div>';
  html += '<div class="date">' + (data.date || "") + '</div>';

  // Lede
  if (data.lede) {
    html += '<p class="lede">' + md(data.lede) + '</p>';
  }

  // Sections grouped by category
  var categories = ["needs_attention", "recent", "coming_up"];
  var categoryLabels = {
    needs_attention: "Needs attention",
    recent: "Recent",
    coming_up: "Coming up"
  };

  var sections = data.sections || [];

  for (var c = 0; c < categories.length; c++) {
    var cat = categories[c];
    var items = sections.filter(function(s) { return s.category === cat; });
    if (items.length === 0) continue;

    html += '<div class="section-divider">' + categoryLabels[cat] + '</div>';

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      html += '<div class="section-item">';
      html += '<span class="dot" style="background:' + dotColor(item.sentiment) + '"></span>';
      html += '<span class="item-text">' + md(item.text) + '</span>';
      if (item.action) {
        var actionJson = JSON.stringify(item.action).replace(/"/g, "&quot;");
        html += '<a class="item-action" href="#" data-action-json="' + actionJson + '">' +
          (item.action.label || "View") + ' \\u2192</a>';
      }
      html += '</div>';
    }
  }

  html += '</div>';
  app.innerHTML = html;

  // Bind action clicks — emit semantic actions, let the shell decide how to handle
  app.addEventListener("click", function(e) {
    var link = e.target.closest("[data-action-json]");
    if (!link) return;
    e.preventDefault();
    try {
      var action = JSON.parse(link.dataset.actionJson);
      var actionType = action.type;
      delete action.type;
      delete action.label;
      emitAction(actionType, action);
    } catch (err) {
      console.warn("[home-dashboard] action parse failed:", err);
    }
  });
}

// --- Load briefing ---
async function loadBriefing(forceRefresh) {
  showSkeleton();
  try {
    var args = forceRefresh ? { force_refresh: true } : {};
    var result = await callTool("briefing", args);
    var data = parseResult(result);
    if (data && typeof data === "object") {
      renderBriefing(data);
    } else {
      showError("Received unexpected data format.");
    }
  } catch (err) {
    showError(err.message || "Failed to load briefing.");
  }
}

// Make loadBriefing available globally for onclick handlers
window.loadBriefing = loadBriefing;

// --- Listen for host messages ---
window.addEventListener("message", function(e) {
  var msg = e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.method === "ui/initialize") {
    loadBriefing();
  } else if (msg.method === "synapse/data-changed") {
    var banner = document.getElementById("refresh-banner");
    if (banner) banner.classList.add("visible");
  }
});

// Also load immediately in case ui/initialize already fired
loadBriefing();
`;
