#!/usr/bin/env node
// A MOCKUP of what `npx nimblebrain` could feel like. Nothing here installs,
// starts, or saves anything: every step is simulated with timers.
//
//   node demo.mjs            the first-run `init` experience
//   node demo.mjs status     the everyday status screen (instant, no motion)
//   node demo.mjs doctor     the machine checklist
//   node demo.mjs error      what a failure looks like
//   add --still              to skip motion (the reduced-motion path)
import { readFileSync } from "node:fs";

const MARK = JSON.parse(readFileSync(new URL("./mark.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) ?? "init";
const STILL = args.includes("--still");
const out = process.stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, STILL ? Math.min(ms, 30) : ms));

if (!out.isTTY) {
  console.log("Run this in a terminal: it is a visual mockup.");
  process.exit(0);
}

// ─── terminal ────────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const fg = ([r, g, b]) => `${ESC}38;2;${r};${g};${b}m`;
const bgc = ([r, g, b]) => `${ESC}48;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`, UNDER = `${ESC}4m`;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const link = (url, text = url) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "").length;
const pad = (s, w) => s + " ".repeat(Math.max(0, w - visLen(s)));

const cleanup = () => {
  out.write(`${RESET}${ESC}?25h`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
};
process.on("exit", cleanup);

// Ask the terminal for its background (OSC 11) so the mark's edges blend into it.
async function terminalBackground() {
  if (!process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let buf = "";
    const done = (v) => {
      process.stdin.off("data", on);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      clearTimeout(t);
      resolve(v);
    };
    const on = (d) => {
      buf += d.toString();
      const m = buf.match(/rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      if (m) done(m.slice(1).map((h) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255)));
    };
    const t = setTimeout(() => done(null), 250);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", on);
    out.write("\x1b]11;?\x07");
  });
}

const BG = (await terminalBackground()) ?? [20, 20, 20];
const DARK = BG[0] * 0.3 + BG[1] * 0.59 + BG[2] * 0.11 < 128;
// Brand values from palette.ts, the dark or light side to match the terminal.
const C = {
  text: hex(DARK ? "#ededed" : "#09090b"),
  muted: hex(DARK ? "#8b8b94" : "#5c5c66"),
  rail: hex(DARK ? "#3a3a42" : "#d4d4d8"),
  primary: hex(DARK ? "#799ff5" : "#315EDB"),
  success: hex(DARK ? "#3fbf85" : "#0f7a4f"),
  warning: hex(DARK ? "#e0aa3c" : "#8a5f0a"),
  danger: hex(DARK ? "#f77970" : "#c02a24"),
  cyan: [14, 145, 252],
  electric: [16, 98, 250],
};
const c = (col, s) => `${fg(col)}${s}${RESET}`;
const muted = (s) => c(C.muted, s);
const rail = c(C.rail, "│");

// The logo's own gradient, across a word.
function gradient(text, bold = true) {
  const n = text.length;
  return [...text].map((ch, i) => `${bold ? BOLD : ""}${fg(mix(C.cyan, C.electric, n > 1 ? i / (n - 1) : 0))}${ch}`).join("") + RESET;
}
const WORDMARK = gradient("N I M B L E B R A I N");

// ─── the mark ───────────────────────────────────────────────────────────────
// The N's stroke, as it is drawn: left foot, up, down into the valley, up to the right.
const N_PATH = [[355, 560], [530, 215], [735, 470], [890, 190]].map(([x, y]) => [x / 1024, y / 868]);
function pathParam(x, y) {
  let best = Infinity, at = 0, run = 0;
  const lens = [];
  for (let i = 0; i < N_PATH.length - 1; i++) {
    const [ax, ay] = N_PATH[i], [bx, by] = N_PATH[i + 1];
    lens.push(Math.hypot((bx - ax) * 1024, (by - ay) * 868));
  }
  const total = lens.reduce((a, b) => a + b);
  for (let i = 0; i < N_PATH.length - 1; i++) {
    const [ax, ay] = N_PATH[i], [bx, by] = N_PATH[i + 1];
    const dx = (bx - ax) * 1024, dy = (by - ay) * 868;
    const px = (x - ax) * 1024, py = (y - ay) * 868;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < best) { best = d; at = (run + t * lens[i]) / total; }
    run += lens[i];
  }
  return at;
}

function prepare(size) {
  const g = MARK.sizes[size];
  const shapes = new Map(MARK.shapes.map((s) => [s.id, { ...s, cx: s.x * g.cols, cy: s.y * g.rows, r: 0.5 }]));
  const pix = [];
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) {
      const p = g.px[y][x];
      if (!p) continue;
      const s = shapes.get(p[0]);
      const d = Math.hypot(x + 0.5 - s.cx, y + 0.5 - s.cy);
      s.r = Math.max(s.r, d);
      pix.push({ x, y, id: p[0], rgb: [p[1], p[2], p[3]], a: p[4], d, t: p[0] === 0 ? pathParam((x + 0.5) / g.cols, (y + 0.5) / g.rows) : 0 });
    }
  // Dots arrive in a scattered order that still reads as filling in from the N outward.
  const nc = { x: 0.6 * g.cols, y: 0.45 * g.rows };
  const dots = [...shapes.values()].filter((s) => s.id !== 0)
    .map((s) => ({ s, k: Math.hypot(s.cx - nc.x, (s.cy - nc.y) * 1.4) + ((s.id * 7919) % 13) }))
    .sort((a, b) => a.k - b.k)
    .map((d, i) => { d.s.order = i; return d.s; });
  return { ...g, shapes, pix, dots, nc };
}

/**
 * One frame of the mark as text lines. `scene`:
 *   dots    0..1  how many dots have popped in
 *   n       0..1  how far the N has been drawn
 *   sweep   null or the x of a band of light crossing the N
 *   pulse   null or the radius of a ring of light running out through the dots
 *   now     ms, for each dot's pop easing
 */
// The mark powered off: its own luminance, pushed back toward the background.
const ghost = (rgb) => { const l = Math.round(rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11); return mix(BG, [l, l, l], 0.38); };

function drawMark(m, scene) {
  const grid = Array.from({ length: m.rows }, () => Array(m.cols).fill(null));
  const ndots = m.dots.length;
  for (const p of m.pix) {
    let rgb = p.rgb, a = p.a;
    if (p.id === 0) {
      if (scene.n <= 0 || p.t > scene.n) {
        if (!scene.ghost) continue;
        grid[p.y][p.x] = mix(BG, ghost(rgb), a);
        continue;
      }
      // The drawing edge glows.
      const edge = scene.n < 1 ? 1 - Math.min(1, (scene.n - p.t) / 0.06) : 0;
      if (edge > 0) rgb = mix(rgb, [210, 235, 255], edge * 0.8);
      if (scene.sweep != null) {
        const k = Math.max(0, 1 - Math.abs(p.x + p.y * 0.8 - scene.sweep) / 4);
        rgb = mix(rgb, [225, 240, 255], k * 0.75);
      }
    } else {
      const s = m.shapes.get(p.id);
      const shown = scene.dots * ndots - s.order; // >0 once this dot's turn has come
      if (shown <= 0) {
        if (!scene.ghost) continue;
        grid[p.y][p.x] = mix(BG, ghost(rgb), a);
        continue;
      }
      const e = Math.min(1, shown * 1.6);
      const pop = e < 1 ? 1.25 * Math.sin((e * Math.PI) / 2) : 1; // overshoot, then settle
      if (p.d > s.r * Math.min(pop, 1.25) + 0.3) {
        if (scene.ghost && p.d <= s.r + 0.3) grid[p.y][p.x] = mix(BG, ghost(rgb), a);
        continue;
      }
      if (e < 1) rgb = mix(rgb, [235, 240, 255], 1 - e);
      if (scene.pulse != null) {
        const dd = Math.hypot(s.cx - m.nc.x, (s.cy - m.nc.y) * 1.4);
        const k = Math.max(0, 1 - Math.abs(dd - scene.pulse) / 5);
        rgb = mix(rgb, [190, 215, 255], k * 0.7);
      }
    }
    grid[p.y][p.x] = mix(BG, rgb, a);
  }
  const lines = [];
  for (let y = 0; y < m.rows; y += 2) {
    let s = "";
    for (let x = 0; x < m.cols; x++) {
      const t = grid[y][x], b = grid[y + 1]?.[x];
      if (t && b) s += `${fg(t)}${bgc(b)}▀${RESET}`;
      else if (t) s += `${fg(t)}▀${RESET}`;
      else if (b) s += `${fg(b)}▄${RESET}`;
      else s += " ";
    }
    lines.push(s);
  }
  return lines;
}

// ─── a redrawable region (no alternate screen: the result stays in scrollback) ──
function region() {
  let height = 0;
  return {
    paint(lines) {
      let s = height ? `${ESC}${height}A` : "";
      for (const l of lines) s += `\r${ESC}2K${l}\n`;
      for (let i = lines.length; i < height; i++) s += `\r${ESC}2K\n`;
      out.write(s);
      height = Math.max(height, lines.length);
    },
  };
}

function sideBySide(left, leftW, right, gap = 4) {
  const n = Math.max(left.length, right.length);
  const top = Math.max(0, Math.floor((left.length - right.length) / 2));
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(pad(left[i] ?? "", leftW) + " ".repeat(gap) + (right[i - top] ?? ""));
  return lines;
}

// ─── input (raw mode, so prompts live inside the painted region) ─────────────
function keys(handler) {
  return new Promise((resolve) => {
    const on = (d) => {
      const k = d.toString();
      if (k === "\x03") { cleanup(); out.write("\n"); process.exit(130); }
      const r = handler(k);
      if (r !== undefined) {
        process.stdin.off("data", on);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(r);
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", on);
  });
}

// ─── init ────────────────────────────────────────────────────────────────────
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

async function init() {
  const cols = out.columns || 80;
  const size = cols >= 112 ? "large" : cols >= 92 ? "medium" : "small";
  const m = prepare(size);
  const stacked = cols < 92;
  const scene = { dots: 0, n: 0, sweep: null, pulse: null };
  const steps = []; // {state: wait|run|done|warn|ask, title, detail, extra:[]}
  let prompt = null; // lines rendered under the active step while asking
  let footer = [];
  const t0 = Date.now();
  let frame = 0;

  const panel = () => {
    const L = [WORDMARK, muted("the open-source runtime for agents and MCP apps"), muted("cli 0.4.0 · runtime v0.52.1"), ""];
    for (const [i, s] of steps.entries()) {
      const sym = { wait: c(C.rail, "○"), run: c(C.primary, SPIN[frame % SPIN.length]), ask: c(C.primary, "◆"), done: c(C.success, "◇"), warn: c(C.warning, "▲") }[s.state];
      const title = s.state === "wait" ? muted(s.title) : s.state === "done" ? s.title : `${BOLD}${s.title}${RESET}`;
      L.push(`${sym}  ${title}${s.after ? "  " + s.after : ""}`);
      const body = s.state === "ask" && prompt ? prompt : [...(s.detail ? [muted(s.detail)] : []), ...(s.extra ?? [])];
      for (const b of body) L.push(`${rail}  ${b}`);
      if (i < steps.length - 1) L.push(rail);
    }
    return [...L, ...footer];
  };

  const r = region();
  const paint = () => {
    const mark = drawMark(m, scene);
    const p = panel();
    r.paint(stacked ? [...mark, "", ...p] : ["", ...sideBySide(mark, m.cols, p), ""]);
  };
  out.write(`${ESC}?25l`);
  const loop = setInterval(() => { frame++; paint(); }, 40);
  const tween = async (key, to, ms) => {
    const from = scene[key], start = Date.now();
    while (true) {
      const k = STILL ? 1 : Math.min(1, (Date.now() - start) / ms);
      scene[key] = from + (to - from) * (1 - (1 - k) ** 2);
      if (k >= 1) break;
      await sleep(16);
    }
  };

  // 1. Power on: the dots pop in.
  await tween("dots", 1, 1600);

  // 2. The one question asked before anything else (telemetry), as the "press start" moment.
  const tel = { state: "ask", title: "Share anonymous usage data?" };
  steps.push(tel);
  let yes = true;
  const drawToggle = () => {
    prompt = [
      `${yes ? c(C.primary, "●") : muted("○")} ${yes ? "Yes" : muted("Yes")}   ${!yes ? c(C.primary, "●") : muted("○")} ${!yes ? "No" : muted("No")}`,
      muted("helps us improve NimbleBrain · no prompts or keys, ever"),
      muted("←/→ to choose · enter to confirm"),
    ];
  };
  drawToggle();
  await keys((k) => {
    if (k === "\r") return true;
    if (["\x1b[D", "\x1b[C", "h", "l", "\t"].includes(k)) { yes = !yes; drawToggle(); }
    if (k === "y") { yes = true; drawToggle(); }
    if (k === "n") { yes = false; drawToggle(); }
  });
  prompt = null;
  Object.assign(tel, { state: "done", title: "Usage data", after: yes ? c(C.primary, "on") : muted("off"), detail: "" });

  // 3. Checks.
  const chk = { state: "run", title: "Checking this machine" };
  steps.push(chk);
  const found = [];
  for (const [name, val] of [["docker", "27.3.1"], ["compose", "v2.29"], ["arm64", ""], ["16 GB", ""], ["port 27246", "free"]]) {
    await sleep(260);
    found.push(`${c(C.success, "✓")} ${name}${val ? " " + muted(val) : ""}`);
    chk.extra = [found.slice(0, 3).join("  "), found.slice(3).join("  ")].filter(Boolean);
  }
  await sleep(200);
  Object.assign(chk, { state: "done", title: "This machine is ready", extra: [], detail: "Docker 27.3.1 · arm64 · 16 GB · port 27246 free" });

  // 4. Pull: the N starts drawing with the download.
  const pull = { state: "run", title: "Pulling runtime v0.52.1" };
  steps.push(pull);
  const W = 22, TOTAL = 412;
  const startPull = Date.now(), PULL_MS = 4200;
  while (true) {
    const k = STILL ? 1 : Math.min(1, (Date.now() - startPull) / PULL_MS);
    const e = k < 0.15 ? k * 0.6 : 0.09 + (k - 0.15) * 1.07; // a slow start, like a real pull
    const f = Math.min(1, e);
    scene.n = f * 0.62;
    const filled = Math.round(f * W);
    pull.extra = [`${c(C.primary, "━".repeat(filled))}${c(C.rail, "━".repeat(W - filled))}  ${String(Math.round(f * 100)).padStart(3)}%  ${muted(`${Math.round(f * TOTAL)}/${TOTAL} MB`)}`];
    if (k >= 1) break;
    await sleep(40);
  }
  Object.assign(pull, { state: "done", title: "Runtime v0.52.1", extra: [], detail: "4 images · 412 MB" });

  // 5. Model: a select, then a hidden key.
  const model = { state: "ask", title: "Which model should your agents use?" };
  steps.push(model);
  const opts = [["Anthropic", "Claude"], ["OpenAI", "GPT"], ["Google", "Gemini"], ["Local", "Ollama on this machine, no key"]];
  let sel = 0;
  const drawSel = () => {
    prompt = [...opts.map(([n, d], i) => (i === sel ? `${c(C.primary, "●")} ${n} ${muted(d)}` : `${muted("○")} ${muted(n)}`)), muted("↑/↓ to choose · enter to confirm")];
  };
  drawSel();
  await keys((k) => {
    if (k === "\r") return true;
    if (k === "\x1b[A" || k === "k") { sel = (sel + opts.length - 1) % opts.length; drawSel(); }
    if (k === "\x1b[B" || k === "j") { sel = (sel + 1) % opts.length; drawSel(); }
  });
  const provider = opts[sel][0];
  if (provider === "Local") {
    Object.assign(model, { state: "done", title: "Model", after: c(C.primary, "Local · llama3.1"), detail: "Ollama is running · context fixed at 32k" });
    prompt = null;
  } else {
    model.title = `Paste your ${provider} key`;
    let key = "";
    const drawKey = () => {
      prompt = [
        `${key ? c(C.primary, "•".repeat(Math.min(key.length, 32))) : muted("hidden as you type")}${c(C.primary, "▏")}`,
        muted("mockup: type anything, nothing is saved · enter to skip"),
      ];
    };
    drawKey();
    await keys((k) => {
      if (k === "\r") return true;
      if (k === "\x7f") key = key.slice(0, -1);
      else if (!k.startsWith("\x1b")) key += k.replace(/[\r\n]/g, "");
      drawKey();
    });
    prompt = null;
    Object.assign(model, key
      ? { state: "done", title: "Model", after: c(C.primary, provider), detail: "key saved to ~/.nimblebrain/.env · only you can read it" }
      : { state: "warn", title: "Model", after: muted("no key yet"), detail: "add it later: npx nimblebrain key" });
  }

  // 6. Start: the N finishes as the runtime comes up healthy.
  const start = { state: "run", title: "Starting NimbleBrain" };
  steps.push(start);
  const startAt = Date.now();
  const startPromise = tween("n", 1, 2600);
  while (Date.now() - startAt < (STILL ? 0 : 2600)) {
    start.extra = [muted(`waiting for health · ${((Date.now() - startAt) / 1000).toFixed(1)}s`)];
    await sleep(80);
  }
  await startPromise;
  Object.assign(start, { state: "done", title: "NimbleBrain is running", extra: [], detail: "healthy in 6.2s" });

  // 7. Agents: a multiselect of what was found on this machine.
  const ag = { state: "ask", title: "Connect a coding agent?" };
  steps.push(ag);
  const agents = [["Claude Code", true, true], ["Cursor", true, false], ["Codex", false, false]];
  let at = 0;
  const drawAg = () => {
    prompt = [
      ...agents.map(([n, ok, on], i) => {
        const box = on ? c(C.primary, "◼") : muted("◻");
        const label = i === at ? `${BOLD}${n}${RESET}` : n;
        return `${i === at ? c(C.primary, "›") : " "} ${box} ${label} ${muted(ok ? "found" : "not found")}`;
      }),
      muted("space to toggle · enter to confirm"),
    ];
  };
  drawAg();
  await keys((k) => {
    if (k === "\r") return true;
    if (k === "\x1b[A" || k === "k") at = (at + agents.length - 1) % agents.length;
    if (k === "\x1b[B" || k === "j") at = (at + 1) % agents.length;
    if (k === " ") agents[at][2] = !agents[at][2];
    drawAg();
  });
  prompt = null;
  const picked = agents.filter((a) => a[2]).map((a) => a[0]);
  Object.assign(ag, picked.length
    ? { state: "done", title: "Connected", after: c(C.primary, picked.join(", ")), detail: "workspace default · nimblebrain skill installed" }
    : { state: "done", title: "No agent connected", detail: "connect one later: npx nimblebrain connect" });

  // 8. Ready: light runs along the N, then out through the dots.
  const secs = Math.round((Date.now() - t0) / 1000);
  footer = [
    rail,
    `${c(C.success, "└")}  ${BOLD}Ready${RESET} ${muted(`in ${secs}s`)}`,
    "",
    `   ${c(C.primary, UNDER + link("http://127.0.0.1:27246") + RESET)}  ${muted("open it in your browser")}`,
    `   ${muted("mcp")}  http://127.0.0.1:27246/mcp/ws_8k2f`,
    "",
    `   ${muted("next")}  try ${BOLD}npx nimblebrain status${RESET}`,
  ];
  if (!STILL) {
    for (let x = -6; x <= m.cols + 10; x += 1.4) { scene.sweep = x; await sleep(22); }
    scene.sweep = null;
    for (let rr = 0; rr <= m.cols; rr += 1.2) { scene.pulse = rr; await sleep(22); }
    scene.pulse = null;
  }
  clearInterval(loop);
  paint();
  out.write(`${ESC}?25h`);
}

// ─── status: instant, no motion; you run it every day. The brain is the status light. ──
function status() {
  const stopped = args.includes("--stopped");
  const m = prepare("small");
  const mark = drawMark(m, stopped ? { dots: 0, n: 0, ghost: true } : { dots: 1, n: 1 });
  const k = (s) => muted(s.padEnd(11));
  const right = stopped
    ? [
        `${WORDMARK}   ${muted("○")} stopped`,
        muted("runtime v0.52.1 · cli 0.4.0 · stopped 2d ago"),
        "",
        `${k("data")}kept ${muted("· 2 workspaces, 41 conversations")}`,
        `${k("model")}Anthropic ${muted("· key set")}`,
        "",
        `${k("start")}${BOLD}npx nimblebrain up${RESET}`,
      ]
    : [
        `${WORDMARK}   ${c(C.success, "●")} running`,
        muted("runtime v0.52.1 · cli 0.4.0 · up 3h 12m"),
        "",
        `${k("url")}${c(C.primary, UNDER + link("http://127.0.0.1:27246") + RESET)}`,
        `${k("model")}Anthropic ${muted("· key set")}`,
        `${k("agents")}Claude Code, Cursor`,
        `${k("workspaces")}default   ${muted("12 apps · /mcp/ws_8k2f")}`,
        `${k("")}research  ${muted(" 3 apps · /mcp/ws_q91c")}`,
        "",
        `${c(C.warning, "▲")} runtime v0.53.0 is out ${muted("·")} npx nimblebrain update`,
      ];
  console.log(["", ...sideBySide(mark, m.cols, right, 4), ""].join("\n"));
}

// ─── a small brain beside a panel, animated while a state change runs ───────
function stage(scene, panel) {
  const m = prepare("small");
  const r = region();
  let frame = 0;
  const paint = () => r.paint(["", ...sideBySide(drawMark(m, scene), m.cols, panel(frame), 4), ""]);
  out.write(`${ESC}?25l`);
  const loop = setInterval(() => { frame++; paint(); }, 40);
  return {
    m,
    async tween(key, to, ms) {
      const from = scene[key], start = Date.now();
      while (true) {
        const k = STILL ? 1 : Math.min(1, (Date.now() - start) / ms);
        scene[key] = from + (to - from) * (1 - (1 - k) ** 2);
        if (k >= 1) break;
        await sleep(16);
      }
    },
    async light() {
      if (STILL) return;
      for (let x = -6; x <= m.cols + 8; x += 1.2) { scene.sweep = x; await sleep(22); }
      scene.sweep = null;
      for (let rr = 0; rr <= m.cols; rr += 1) { scene.pulse = rr; await sleep(22); }
      scene.pulse = null;
    },
    end() { clearInterval(loop); paint(); out.write(`${ESC}?25h`); },
  };
}
const spin = (f) => c(C.primary, SPIN[f % SPIN.length]);
const url = () => c(C.primary, UNDER + link("http://127.0.0.1:27246") + RESET);

// up: the grey brain lights along the N as health comes up, then the dots.
async function up() {
  const scene = { dots: 0, n: 0, ghost: true };
  let state = "start", t0 = Date.now();
  const s = stage(scene, (f) => state === "start"
    ? [`${WORDMARK}`, "", `${spin(f)}  Starting NimbleBrain v0.52.1`, `${rail}  ${muted(`waiting for health · ${((Date.now() - t0) / 1000).toFixed(1)}s`)}`]
    : [`${WORDMARK}   ${c(C.success, "●")} running`, "", `${c(C.success, "◇")}  Started ${muted("· healthy in 5.8s")}`, "", `   ${url()}`]);
  await s.tween("n", 1, 2600);
  await s.tween("dots", 1, 900);
  state = "done";
  await s.light();
  s.end();
}

// down: the dots go out, then the N; what is left is the grey, powered-off brain.
async function down() {
  const scene = { dots: 1, n: 1, ghost: true };
  let state = "stop";
  const s = stage(scene, (f) => state === "stop"
    ? [`${WORDMARK}`, "", `${spin(f)}  Stopping NimbleBrain`]
    : [`${WORDMARK}   ${muted("○")} stopped`, "", `${c(C.success, "◇")}  Stopped ${muted("· your data is kept")}`, "", `   ${muted("start again")}  npx nimblebrain up`]);
  await s.tween("dots", 0, 900);
  await s.tween("n", 0, 900);
  state = "done";
  s.end();
}

// update: the old N greys out, the new one draws with the pull, then a restart.
async function update() {
  const scene = { dots: 1, n: 1, ghost: true };
  let step = "pull", pct = 0;
  const notes = [muted("· tasks can run on a schedule per workspace"), muted("· faster connector start"), muted("· 14 fixes")];
  const s = stage(scene, (f) => {
    const head = [`${WORDMARK}`, `${muted("runtime")} v0.52.1 ${c(C.primary, "→")} ${BOLD}v0.53.0${RESET}`, ""];
    if (step === "pull") {
      const W = 20, fill = Math.round(pct * W);
      return [...head, `${spin(f)}  Pulling v0.53.0`, `${rail}  ${c(C.primary, "━".repeat(fill))}${c(C.rail, "━".repeat(W - fill))}  ${String(Math.round(pct * 100)).padStart(3)}%`];
    }
    if (step === "restart") return [...head, `${c(C.success, "◇")}  Pulled ${muted("· 3 images · 96 MB")}`, rail, `${spin(f)}  Restarting`];
    return [...head, `${c(C.success, "◇")}  Updated ${muted("· your data and settings are kept")}`, ...notes.map((n) => `${rail}  ${n}`), `${c(C.success, "└")}  ${url()}`];
  });
  await s.tween("n", 0, 500);
  const start = Date.now();
  while (true) {
    const k = STILL ? 1 : Math.min(1, (Date.now() - start) / 3200);
    pct = k; scene.n = k * 0.85;
    if (k >= 1) break;
    await sleep(40);
  }
  step = "restart";
  await s.tween("n", 1, 1400);
  step = "done";
  await s.light();
  s.end();
}

// uninstall: asks plainly, then every dot goes out for good.
async function uninstall() {
  out.write(`\n${c(C.danger, "▲")}  ${BOLD}Remove NimbleBrain and every conversation in it?${RESET}\n${rail}  ${muted("2 workspaces · 41 conversations · this can't be undone")}\n${rail}  ${muted("type")} remove ${muted("to confirm, or press enter to keep it")}\n${rail}  `);
  let typed = "";
  out.write(`${ESC}?25h`);
  const ok = await keys((k) => {
    if (k === "\r") return typed === "remove";
    if (k === "\x7f") { if (typed) { typed = typed.slice(0, -1); out.write("\b \b"); } return; }
    if (!k.startsWith("\x1b")) { typed += k; out.write(c(C.danger, k)); }
  });
  out.write("\n");
  if (!ok) { console.log(`${c(C.success, "└")}  Kept. Nothing was removed.\n`); return; }
  const scene = { dots: 1, n: 1 };
  let done = false;
  const s = stage(scene, (f) => done
    ? [`${muted("NimbleBrain is removed, with its data.")}`, "", muted("thanks for trying it · come back anytime:"), "npx nimblebrain"]
    : [`${spin(f)}  Removing containers and data`]);
  await s.tween("dots", 0, 1400);
  await s.tween("n", 0, 900);
  done = true;
  s.end();
}

// mcp: plain lines and a table. No brain: this is a list you read and pipe.
function mcp() {
  const sub = args.filter((a) => !a.startsWith("-"))[1] ?? "list";
  if (sub === "add") {
    console.log(`\n${c(C.success, "✓")}  Added ${BOLD}weather-dev${RESET} to workspace default ${muted("· 4 tools · stdio: node ./server.js")}\n${rail}\n${c(C.success, "└")}  ${muted("try it in chat, or list it:")} npx nimblebrain mcp list\n`);
    return;
  }
  const rows = [["weather-dev", "running", "4", "stdio · node ./server.js"], ["crm-local", "running", "12", "http · localhost:8811"], ["scraper", "error", "–", "stdio · uv run scraper"]];
  const L = ["", `${BOLD}MCP servers in development${RESET} ${muted("· workspace default")}`, ""];
  L.push(muted(`   ${"name".padEnd(14)}${"state".padEnd(11)}${"tools".padEnd(7)}runs as`));
  for (const [n, st, t, r] of rows) {
    const dot = st === "running" ? c(C.success, "●") : c(C.danger, "●");
    L.push(`${dot}  ${n.padEnd(14)}${pad(st === "running" ? st : c(C.danger, st), 11)}${t.padEnd(7)}${muted(r)}`);
  }
  L.push("", `${c(C.danger, "▲")}  scraper exited at start ${muted("·")} npx nimblebrain logs`, "");
  console.log(L.join("\n"));
}

// logs: a stream. Colour only marks the level; it stays greppable and pipeable.
async function logs() {
  const lines = [
    ["info", "runtime", "listening on :27247"],
    ["info", "connectors", "weather-dev ready · 4 tools"],
    ["info", "connectors", "crm-local ready · 12 tools"],
    ["warn", "connectors", "scraper exited (code 1), retrying in 5s"],
    ["info", "run", "ws default · chat · 3 tool calls · 2.4s"],
    ["error", "connectors", "scraper: ModuleNotFoundError: No module named 'httpx'"],
  ];
  console.log("");
  for (const [i, [lvl, area, msg]] of lines.entries()) {
    const col = lvl === "error" ? C.danger : lvl === "warn" ? C.warning : C.muted;
    console.log(`${muted(`13:42:${String(i * 7 + 2).padStart(2, "0")}`)}  ${c(col, lvl.padEnd(5))}  ${c(C.primary, area.padEnd(11))}${lvl === "info" ? msg : c(col, msg)}`);
    await sleep(140);
  }
  console.log("");
}

// ─── doctor: a checklist that resolves line by line ─────────────────────────
async function doctor() {
  const checks = [
    ["Docker", "27.3.1, running", "ok"],
    ["Compose", "v2.29", "ok"],
    ["Architecture", "arm64, image published", "ok"],
    ["Memory", "16 GB given to Docker (2 GB needed)", "ok"],
    ["Port 27246", "free", "ok"],
    ["Ollama", "installed, not running", "warn", "start it: open -g -a Ollama"],
    ["Model key", "Anthropic, set", "ok"],
  ];
  const r = region();
  const res = [];
  out.write(`${ESC}?25l`);
  let frame = 0;
  const lines = (running) => {
    const L = ["", `${c(C.primary, "◆")}  ${WORDMARK}  ${muted("doctor")}`, rail];
    for (const [i, [name, detail, st, fix]] of checks.entries()) {
      if (i < res.length) {
        const sym = st === "ok" ? c(C.success, "✓") : c(C.warning, "▲");
        L.push(`${sym}  ${name.padEnd(14)}${muted(detail)}`);
        if (fix) L.push(`${rail}  ${" ".repeat(14)}${c(C.warning, "→")} ${fix}`);
      } else if (i === res.length && running) L.push(`${c(C.primary, SPIN[frame % SPIN.length])}  ${muted(name)}`);
    }
    if (!running) {
      const warn = checks.filter((x) => x[2] === "warn").length;
      L.push(rail, `${c(C.success, "└")}  ${checks.length - warn} ok${warn ? ` · ${c(C.warning, `${warn} to look at`)}` : ""}`, "");
    }
    return L;
  };
  const loop = setInterval(() => { frame++; r.paint(lines(true)); }, 50);
  for (const ch of checks) { await sleep(220 + Math.random() * 260); res.push(ch); }
  clearInterval(loop);
  r.paint(lines(false));
  out.write(`${ESC}?25h`);
}

// ─── error: the same {message, fix} the JSON carries, set so the fix is the thing you see ──
function error() {
  console.log([
    "",
    `${c(C.danger, "✗")}  ${BOLD}Docker isn't running${RESET}  ${muted("DOCKER_NOT_RUNNING")}`,
    `${rail}  NimbleBrain runs in Docker, and the Docker daemon didn't answer.`,
    rail,
    `${c(C.danger, "└")}  ${BOLD}fix${RESET}  Start Docker Desktop, then run this again:`,
    "",
    `      ${c(C.primary, "open -a Docker && npx nimblebrain")}`,
    "",
  ].join("\n"));
}

if (cmd === "status") status();
else if (cmd === "doctor") await doctor();
else if (cmd === "error") error();
else if (cmd === "up") await up();
else if (cmd === "down") await down();
else if (cmd === "update") await update();
else if (cmd === "uninstall") await uninstall();
else if (cmd === "mcp") mcp();
else if (cmd === "logs") await logs();
else await init();
process.exit(0);
