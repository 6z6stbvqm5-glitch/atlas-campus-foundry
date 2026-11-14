import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const DATA_DIR = resolve(OUT, "数据");
const CHARTS = resolve(OUT, "图表");
const raw = JSON.parse(readFileSync(`${DATA_DIR}/scaling-results.json`, "utf8"));
const RES = raw.results;
const KS = raw.assumptions.KS;

const pick = (k, budget, m) => RES.find((r) => r.k === k && r.budget === budget && r.method === m);

const INK = "#2B2418";
const OLIVE = "#6B5B3E";
const RULE = "#8A7A57";
const GOLD = "#D9B878";
const NAVY = "#0C1A33";
const GREEN = "#4E6B4A";
const RED = "#A4553F";
const SERIF = "Georgia, 'Times New Roman', serif";
const CJK = "'Microsoft YaHei', 'PingFang SC', sans-serif";
const COLORS = { general: RED, modules: GREEN, atlas: NAVY, atlas_batch: "#4A6B8A" };

const W = 1600;
const H = 960;
const panels = [
  { x: 110, y: 200, w: 620, h: 250, budget: 18, metric: "rate", title: "开发成功率 · 18 步预算（现状）" },
  { x: 870, y: 200, w: 620, h: 250, budget: 40, metric: "rate", title: "开发成功率 · 40 步预算（硬顶）" },
  { x: 110, y: 600, w: 620, h: 250, budget: 18, metric: "cost", title: "每次成功成本 · 18 步" },
  { x: 870, y: 600, w: 620, h: 250, budget: 40, metric: "cost", title: "每次成功成本 · 40 步" },
];

const xAt = (p, i) => p.x + 84 + (i * (p.w - 130)) / (KS.length - 1);
const yRate = (p, v) => p.y + p.h - (v / 1.0) * p.h;
const LOG_MIN = Math.log10(0.8);
const LOG_MAX = Math.log10(120);
const yCost = (p, v) => p.y + p.h - ((Math.log10(v) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * p.h;

let body = "";
for (const p of panels) {
  body += `<line x1="${p.x + 74}" y1="${p.y}" x2="${p.x + 74}" y2="${p.y + p.h}" stroke="${RULE}" stroke-width="1.5"/>`;
  body += `<line x1="${p.x + 74}" y1="${p.y + p.h}" x2="${p.x + p.w}" y2="${p.y + p.h}" stroke="${RULE}" stroke-width="1.5"/>`;
  body += `<text x="${p.x}" y="${p.y - 22}" font-family="${CJK}" font-size="23" font-weight="bold" fill="${INK}">${p.title}</text>`;
}

// 网格与刻度
for (const p of panels.slice(0, 2)) {
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    body += `<line x1="${p.x + 74}" y1="${yRate(p, t)}" x2="${p.x + p.w}" y2="${yRate(p, t)}" stroke="#E0CFA8" stroke-width="1" stroke-dasharray="4 6"/>`;
    if (p.x < 200) body += `<text x="${p.x + 2}" y="${yRate(p, t) + 7}" font-family="${SERIF}" font-size="18" fill="${OLIVE}">${(t * 100).toFixed(0)}%</text>`;
  });
}
for (const p of panels.slice(2)) {
  [1, 3, 10, 30, 100].forEach((t) => {
    body += `<line x1="${p.x + 74}" y1="${yCost(p, t)}" x2="${p.x + p.w}" y2="${yCost(p, t)}" stroke="#E0CFA8" stroke-width="1" stroke-dasharray="4 6"/>`;
    if (p.x < 200) body += `<text x="${p.x + 6}" y="${yCost(p, t) + 7}" font-family="${SERIF}" font-size="18" fill="${OLIVE}">${t}×</text>`;
  });
}

// x 轴标签
for (const p of panels) {
  KS.forEach((k, i) => {
    body += `<text x="${xAt(p, i)}" y="${p.y + p.h + 28}" font-family="${SERIF}" font-size="20" fill="${OLIVE}" text-anchor="middle">${k}×</text>`;
  });
}

// 数据线
const segments = (p, pts) => {
  let out = "";
  let cur = [];
  for (const q of pts) {
    if (q) cur.push(q);
    else {
      if (cur.length > 1) out += `<polyline points="${cur.map((c) => c.join(",")).join(" ")}" fill="none" stroke-width="3.5" stroke-linejoin="round"/>`;
      cur = [];
    }
  }
  return { out, cur };
};

for (const p of panels) {
  for (const m of ["general", "modules", "atlas", "atlas_batch"]) {
    let pts = [];
    for (let i = 0; i < KS.length; i++) {
      const r = pick(KS[i], p.budget, m);
      if (!r) { pts.push(null); continue; }
      if (m === "atlas_batch" && p.budget !== 18) { pts.push(null); continue; }
      if (p.metric === "rate") pts.push([xAt(p, i), yRate(p, r.winRate)]);
      else if (r.costIndex && r.successes >= 1) pts.push([xAt(p, i), yCost(p, Math.min(r.costIndex, 120))]);
      else pts.push(null);
    }
    // 连线（遇 null 断开）
    const chunks = [];
    let cur = [];
    pts.forEach((q) => {
      if (q) cur.push(q);
      else {
        if (cur.length) chunks.push(cur);
        cur = [];
      }
    });
    if (cur.length) chunks.push(cur);
    chunks.forEach((c) => {
      if (c.length > 1)
        body += `<polyline points="${c.map((q) => q.join(",")).join(" ")}" fill="none" stroke="${COLORS[m]}" stroke-width="3.5" stroke-linejoin="round"/>`;
    });
    pts.forEach((q) => {
      if (q) body += `<circle cx="${q[0]}" cy="${q[1]}" r="5.5" fill="${COLORS[m]}"/>`;
    });
    // 不可行标记：x 轴上画叉
    pts.forEach((q, i) => {
      if (!q)
        body += `<text x="${xAt(p, i)}" y="${p.y + p.h - 8}" font-family="${SERIF}" font-size="18" fill="${COLORS[m]}" text-anchor="middle">×</text>`;
    });
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#FBF6EA"/>
  <text x="70" y="66" font-family="${CJK}" font-size="38" font-weight="bold" fill="${INK}">同比放大：难度 ×2 / ×3 / ×4 / ×6 之后</text>
  <text x="70" y="108" font-family="${CJK}" font-size="21" fill="${OLIVE}">模块数、编排边、配置文件整体等比放大 · 18 次账面口径不变 · 成本以 ATLAS@1× 为 1.00×（对数轴）</text>
  <text x="70" y="140" font-family="${CJK}" font-size="19" fill="${OLIVE}">× = 该规模下 18 次里 1 次都做不成（成本发散）</text>
  ${body}
  <g font-family="${SERIF}" font-size="21">
    <line x1="110" y1="${H - 46}" x2="150" y2="${H - 46}" stroke="${RED}" stroke-width="3.5"/>
    <text x="162" y="${H - 38}" fill="${OLIVE}">General AI</text>
    <line x1="330" y1="${H - 46}" x2="370" y2="${H - 46}" stroke="${GREEN}" stroke-width="3.5"/>
    <text x="382" y="${H - 38}" fill="${OLIVE}">AI + Capability Modules</text>
    <line x1="700" y1="${H - 46}" x2="740" y2="${H - 46}" stroke="${NAVY}" stroke-width="3.5"/>
    <text x="752" y="${H - 38}" fill="${OLIVE}">ATLAS</text>
    <line x1="900" y1="${H - 46}" x2="940" y2="${H - 46}" stroke="#4A6B8A" stroke-width="3.5" stroke-dasharray="7 6"/>
    <text x="952" y="${H - 38}" fill="${OLIVE}">ATLAS + 批量提交（假设）</text>
  </g>
</svg>`;
writeFileSync(`${CHARTS}/scaling-curve.svg`, svg);
await sharp(Buffer.from(svg)).png().toFile(`${CHARTS}/scaling-curve.png`);
console.log("scaling figure written");



