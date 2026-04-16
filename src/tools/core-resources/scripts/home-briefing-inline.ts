import { BRIDGE_HELPER } from "./_bridge.ts";

export const HOME_BRIEFING_INLINE_SCRIPT =
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

function dotColor(sentiment) {
  var root = getComputedStyle(document.documentElement);
  if (sentiment === "positive") return root.getPropertyValue("--nb-color-success").trim() || "#059669";
  if (sentiment === "warning") return root.getPropertyValue("--nb-color-danger").trim() || "#dc2626";
  return root.getPropertyValue("--nb-color-warning").trim() || "#f59e0b";
}

function renderInline(data) {
  var html = '<div class="inline-briefing">';

  html += '<div class="greeting">' + (data.greeting || "Hello") + '</div>';

  if (data.lede) {
    html += '<p class="lede">' + md(data.lede) + '</p>';
  }

  var sections = data.sections || [];
  var categoryLabels = {
    needs_attention: "Needs attention",
    recent: "Recent",
    coming_up: "Coming up"
  };
  var categories = ["needs_attention", "recent", "coming_up"];

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
      html += '</div>';
    }
  }

  html += '</div>';
  app.innerHTML = html;

  // Report height for auto-sizing
  try {
    var height = document.body.scrollHeight;
    window.parent.postMessage({ method: "ui/notifications/size-changed", params: { height: height } }, "*");
  } catch (_) {
    // postMessage may fail if parent frame is detached — not actionable
  }
}

// Listen for tool result from host
window.addEventListener("message", function(e) {
  var msg = e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.method === "synapse/tool-result") {
    var data = msg.params && msg.params.result;
    if (data && typeof data === "object") {
      renderInline(typeof data === "string" ? JSON.parse(data) : data);
    }
  }
});

// Show minimal loading state
app.innerHTML = '<div class="inline-briefing"><div class="greeting" style="color:var(--muted,#71717a)">Loading briefing...</div></div>';
`;
