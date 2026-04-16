import { BRIDGE_HELPER } from "./_bridge.ts";

export const CONVERSATIONS_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");
let allConvs = [];

function render(convs) {
  const list = convs.map(c => {
    const d = new Date(c.createdAt || Date.now());
    const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return '<div class="conv" data-id="' + c.id + '">' +
      '<span class="conv-title">' + escapeHtml(c.title || c.id) + '</span>' +
      '<span class="conv-date">' + dateStr + '</span></div>';
  }).join("");
  app.innerHTML = '<input id="search" type="text" placeholder="Search conversations...">' +
    (list || '<div class="empty">No conversations</div>');
  document.getElementById("search").addEventListener("input", onSearch);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function onSearch(e) {
  const q = e.target.value.toLowerCase();
  const filtered = allConvs.filter(c => (c.title || c.id).toLowerCase().includes(q));
  render(filtered);
  document.getElementById("search").value = e.target.value;
}

app.addEventListener("click", (e) => {
  const el = e.target.closest(".conv");
  if (el) navigate("/conversation/" + el.dataset.id);
});

app.addEventListener("contextmenu", (e) => {
  const el = e.target.closest(".conv");
  if (!el) return;
  e.preventDefault();
  document.querySelectorAll(".ctx-menu").forEach(m => m.remove());
  const id = el.dataset.id;
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  menu.innerHTML = '<div class="ctx-item" data-action="rename">Rename</div><div class="ctx-item" data-action="delete">Delete</div>';
  menu.addEventListener("click", (ev) => {
    const action = ev.target.dataset.action;
    menu.remove();
    if (action === "rename") {
      const title = prompt("New title:");
      if (title) callTool("rename_conversation", { id, title });
    } else if (action === "delete") {
      if (confirm("Delete this conversation?")) {
        callTool("delete_conversation", { id }).then(load);
      }
    }
  });
  document.body.appendChild(menu);
  const dismiss = () => { menu.remove(); document.removeEventListener("click", dismiss); };
  setTimeout(() => document.addEventListener("click", dismiss), 0);
});

async function load() {
  const result = await callTool("list_conversations", {});
  allConvs = (result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result) || [];
  render(allConvs);
}
load();
`;
