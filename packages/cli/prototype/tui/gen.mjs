// Samples the real NimbleBrain mark (web/src/assets/nb-logo-icon-light.svg) into a
// pixel grid for half-block rendering. Every pixel keeps which shape it belongs to:
// shape 0 is the "N" stroke, every other id is one of the dots, so the demo can
// animate them as separate things. Needs ImageMagick (`magick`) to rasterize the
// SVG. Output: mark.json.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const W0 = 1024, H0 = 868;
const svg = new URL("../../../../web/src/assets/nb-logo-icon-light.svg", import.meta.url).pathname;
const raw = execFileSync("magick", ["-background", "none", "-density", "300", svg, "-resize", `${W0}x${H0}!`, "-depth", "8", "rgba:-"], { maxBuffer: 1 << 26 });
const at = (x, y) => (y * W0 + x) * 4;

// 1. Label: -1 empty, 0 the N, 1..n dots (connected components of the lavender).
const label = new Int32Array(W0 * H0).fill(-1);
const isOn = (i) => raw[i * 4 + 3] > 100;
const isN = (i) => raw[i * 4] < 90; // the N is saturated blue; dots are lavender (r≈142)
for (let i = 0; i < W0 * H0; i++) if (isOn(i) && isN(i)) label[i] = 0;
let next = 1;
const stack = [];
for (let i = 0; i < W0 * H0; i++) {
  if (label[i] !== -1 || !isOn(i)) continue;
  label[i] = next;
  stack.push(i);
  while (stack.length) {
    const j = stack.pop();
    const x = j % W0, y = (j / W0) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W0 || ny >= H0) continue;
      const k = ny * W0 + nx;
      if (label[k] === -1 && isOn(k) && !isN(k)) { label[k] = next; stack.push(k); }
    }
  }
  next++;
}

// Shape stats: centre and area (drop anti-alias specks).
const shapes = Array.from({ length: next }, () => ({ sx: 0, sy: 0, n: 0 }));
for (let i = 0; i < W0 * H0; i++) {
  const l = label[i];
  if (l < 0) continue;
  shapes[l].sx += i % W0; shapes[l].sy += (i / W0) | 0; shapes[l].n++;
}

function sample(cols) {
  const rows = Math.round((cols * H0) / W0 / 2) * 2; // pixel rows, even for half-blocks
  const bw = W0 / cols, bh = H0 / rows;
  const px = [];
  for (let gy = 0; gy < rows; gy++) {
    const row = [];
    for (let gx = 0; gx < cols; gx++) {
      const cnt = new Map();
      let total = 0;
      const x0 = Math.floor(gx * bw), x1 = Math.floor((gx + 1) * bw);
      const y0 = Math.floor(gy * bh), y1 = Math.floor((gy + 1) * bh);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          total++;
          const l = label[y * W0 + x];
          if (l < 0 || shapes[l].n < 200) continue;
          const c = cnt.get(l) ?? { n: 0, r: 0, g: 0, b: 0, a: 0 };
          const i = at(x, y);
          c.n++; c.r += raw[i]; c.g += raw[i + 1]; c.b += raw[i + 2]; c.a += raw[i + 3] / 255;
          cnt.set(l, c);
        }
      let best = null, bestId = -1;
      for (const [id, c] of cnt) if (!best || c.n > best.n) { best = c; bestId = id; }
      // Coverage is kept as alpha, so edges anti-alias against the terminal's background.
      let a = 0;
      for (const c of cnt.values()) a += c.a;
      a = a / total;
      if (best && a > 0.06)
        row.push([bestId, Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n), Math.round(Math.min(1, a * 1.15) * 100) / 100]);
      else row.push(null);
    }
    px.push(row);
  }
  return { cols, rows, px };
}

const out = {
  shapes: shapes.map((s, id) => ({ id, x: s.sx / s.n / W0, y: s.sy / s.n / H0, area: s.n })).filter((s) => s.area >= 200),
  sizes: { large: sample(60), medium: sample(44), small: sample(28) },
};
writeFileSync(new URL("./mark.json", import.meta.url), JSON.stringify(out));
console.log(`shapes: ${out.shapes.length} (1 N + ${out.shapes.length - 1} dots)`);
for (const [k, v] of Object.entries(out.sizes)) console.log(k, v.cols, "x", v.rows / 2, "lines");
