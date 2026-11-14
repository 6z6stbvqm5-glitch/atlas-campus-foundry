import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const DATA_DIR = resolve(OUT, "数据");
const CHARTS = resolve(OUT, "图表");
const data = JSON.parse(readFileSync(`${DATA_DIR}/simulation-results.json`, "utf8"));
const RES = data.results;
const g = (k) => RES.find((r) => r.key === k);
const general = g("general");
const modules = g("modules");
const atlas = g("atlas");

const BONE = "#F2E4C8";
const INK = "#2B2418";
const GOLD = "#D9B878";
const GOLD_SOFT = "#E7D7B4";
const NAVY = "#0C1A33";
const OLIVE = "#6B5B3E";
const RULE = "#8A7A57";
const GREEN = "#4E6B4A";
const RED = "#A4553F";
const SERIF = "Georgia, 'Times New Roman', serif";
const CJK = "'Microsoft YaHei', 'PingFang SC', sans-serif";

/* ---------- 图 A ---------- */
const W = 1600;
const H = 790;
const rows = [
  { label: "General AI", res: general, y: 244 },
  { label: "AI + Capability Modules", res: modules, y: 334 },
  { label: "ATLAS", res: atlas, y: 434, accent: true },
];
const barX = 470;
const cellW = 26;
const cellH = 20;
const gap = 4;

const bars = (res, yBase, accent) =>
  res.runs
    .map((r, i) => {
      const x = barX + i * (cellW + gap);
      const fill = r.ok ? GOLD : accent ? "#2A3B57" : GOLD_SOFT;
      return `<rect x="${x}" y="${yBase - cellH}" width="${cellW}" height="${cellH}" fill="${fill}"/>`;
    })
    .join("");

const rowSvg = rows
  .map((r) => {
    const block = r.accent ? `<rect x="40" y="${r.y - 62}" width="1000" height="120" fill="${NAVY}"/>` : "";
    const labelColor = r.accent ? "#F7EFDD" : INK;
    const subColor = r.accent ? GOLD : OLIVE;
    const numColor = r.accent ? "#F7EFDD" : INK;
    return `${block}
    <text x="72" y="${r.y}" font-family="${SERIF}" font-size="34" fill="${labelColor}">${r.label}</text>
    <text x="${barX}" y="${r.y - 36}" font-family="${SERIF}" font-size="30" font-weight="bold" fill="${numColor}">${r.res.summary.successes} / 18</text>
    ${bars(r.res, r.y + 6, r.accent)}
    <text x="1078" y="${r.y - 4}" font-family="${SERIF}" font-size="30" font-style="italic" fill="${subColor}">$${r.res.summary.usd_per_success.toFixed(3)}</text>
    <text x="1078" y="${r.y + 28}" font-family="${SERIF}" font-size="20" fill="${subColor}">${r.res.summary.cost_index.toFixed(2)}× baseline</text>`;
  })
  .join("");

const grid = Array.from({ length: 12 }, (_, i) => `<line x1="${(i + 1) * 130}" y1="0" x2="${(i + 1) * 130}" y2="${H}"/>`).join("");

const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BONE}"/>
  <g opacity="0.3" stroke="#DCCBAA" stroke-width="1">${grid}</g>
  <text x="60" y="80" font-family="${SERIF}" font-size="50" font-weight="bold" fill="${INK}">Comparative Evaluation: Build Success and Cost</text>
  <line x1="60" y1="118" x2="${W - 60}" y2="118" stroke="${RULE}" stroke-width="2"/>
  <text x="60" y="168" font-family="${SERIF}" font-size="29" font-weight="bold" fill="${INK}">Method</text>
  <text x="${barX}" y="168" font-family="${SERIF}" font-size="29" font-weight="bold" fill="${INK}">Successful Builds</text>
  <text x="1074" y="168" font-family="${SERIF}" font-size="29" font-weight="bold" fill="${INK}">Cost per Success</text>
  <line x1="60" y1="188" x2="${W - 60}" y2="188" stroke="${RULE}" stroke-width="1.5"/>
  ${rowSvg}
  <rect x="470" y="${H - 276}" width="26" height="18" fill="${GOLD}"/>
  <text x="506" y="${H - 260}" font-family="${SERIF}" font-size="22" fill="${OLIVE}">Successful build</text>
  <rect x="716" y="${H - 276}" width="26" height="18" fill="${GOLD_SOFT}"/>
  <text x="752" y="${H - 260}" font-family="${SERIF}" font-size="22" fill="${OLIVE}">Failed attempt</text>
  <line x1="60" y1="${H - 168}" x2="150" y2="${H - 168}" stroke="${RULE}" stroke-width="1"/>
  <text x="60" y="${H - 136}" font-family="${SERIF}" font-size="17" fill="${OLIVE}">Same requirement set · same model (deepseek-chat) · 18 attempts per method</text>
  <text x="60" y="${H - 110}" font-family="${SERIF}" font-size="17" fill="${OLIVE}">est. by Monte Carlo over 5 escalating difficulty levels · 5000 trials per cell · cost = USD per successful build</text>
  <g opacity="0.9">
    <path d="M 1330 ${H - 40} A 270 270 0 0 1 1595 ${H - 310}" fill="none" stroke="${RULE}" stroke-width="2"/>
    <path d="M 1352 ${H - 40} A 248 248 0 0 1 1595 ${H - 288}" fill="none" stroke="${RULE}" stroke-width="1.5"/>
    <path d="M 1374 ${H - 40} A 226 226 0 0 1 1595 ${H - 266}" fill="none" stroke="${RULE}" stroke-width="1"/>
  </g>
  <text x="1112" y="${H - 232}" font-family="${SERIF}" font-size="126" font-weight="bold" fill="${OLIVE}">${(atlas.summary.successes / general.summary.successes).toFixed(1)}×</text>
  <text x="1150" y="${H - 176}" font-family="${SERIF}" font-size="30" fill="${OLIVE}">successful builds</text>
  <text x="1150" y="${H - 142}" font-family="${SERIF}" font-size="23" fill="${OLIVE}">VS. GENERAL AI</text>
</svg>`;
writeFileSync(`${CHARTS}/poster-comparison.svg`, poster);

/* ---------- 图 B ---------- */
const W2 = 1600;
const H2 = 860;
const panelL = { x: 90, y: 196, w: 660, h: 510 };
const panelR = { x: 850, y: 196, w: 660, h: 510 };
const levels = [1, 2, 3, 4, 5];
const xAt = (i) => panelL.x + 70 + (i * (panelL.w - 130)) / 4;
const xAtR = (i) => panelR.x + 70 + (i * (panelR.w - 130)) / 4;
const yP = (p) => panelL.y + panelL.h - 40 - p * (panelL.h - 110);
const MAXC = 3;
const Y_MIN = 0.3;
const Y_MAX = 30;
const log10 = (v) => Math.log10(v);
const yC = (c) => {
  const v = Math.min(Math.max(c, Y_MIN), Y_MAX);
  return panelR.y + panelR.h - 40 - ((log10(v) - log10(Y_MIN)) / (log10(Y_MAX) - log10(Y_MIN))) * (panelR.h - 110);
};

const axis = (p, title) =>
  `<text x="${p.x}" y="${p.y - 28}" font-family="${CJK}" font-size="29" font-weight="bold" fill="${INK}">${title}</text>
   <line x1="${p.x}" y1="${p.y + p.h - 40}" x2="${p.x + p.w}" y2="${p.y + p.h - 40}" stroke="${RULE}" stroke-width="1.5"/>
   <line x1="${p.x + 60}" y1="${p.y}" x2="${p.x + 60}" y2="${p.y + p.h - 40}" stroke="${RULE}" stroke-width="1.5"/>`;

const poly = (pts, color) => `<polyline points="${pts.map((q) => `${q[0]},${q[1]}`).join(" ")}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linejoin="round"/>`;
const dots = (pts, color) => pts.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="6.5" fill="${color}"/>`).join("");

const succ = (res, color) => {
  const pts = res.perLevel.map((l, i) => [xAt(i), yP(l.p_measured)]);
  return poly(pts, color) + dots(pts, color);
};
const cost = (res, color) => {
  const pts = res.perLevel.map((l, i) => [xAtR(i), yC(l.cost_index)]);
  return poly(pts, color) + dots(pts, color);
};

let ticks = "";
[0, 0.25, 0.5, 0.75, 1].forEach((t) => {
  ticks += `<text x="${panelL.x + 14}" y="${yP(t) + (t === 0 ? -12 : 8)}" font-family="${SERIF}" font-size="19" fill="${OLIVE}">${(t * 100).toFixed(0)}%</text>`;
  ticks += `<line x1="${panelL.x + 74}" y1="${yP(t)}" x2="${panelL.x + panelL.w}" y2="${yP(t)}" stroke="#E0CFA8" stroke-width="1" stroke-dasharray="4 6"/>`;
});
[0.5, 1, 3, 10, 30].forEach((t) => {
  ticks += `<text x="${panelR.x + 14}" y="${yC(t) + 8}" font-family="${SERIF}" font-size="20" fill="${OLIVE}">${t}×</text>`;
  ticks += `<line x1="${panelR.x + 74}" y1="${yC(t)}" x2="${panelR.x + panelR.w}" y2="${yC(t)}" stroke="#E0CFA8" stroke-width="1" stroke-dasharray="4 6"/>`;
});

const tags = ["单块", "双块", "三块+视图", "编排", "自定义码"];
const xlabels = levels
  .map(
    (lv, i) =>
      `<text x="${xAt(i)}" y="${panelL.y + panelL.h - 12}" font-family="${SERIF}" font-size="22" fill="${OLIVE}" text-anchor="middle">L${lv}</text>` +
      `<text x="${xAt(i)}" y="${panelL.y + panelL.h + 18}" font-family="${CJK}" font-size="16" fill="${OLIVE}" text-anchor="middle">${tags[i]}</text>` +
      `<text x="${xAtR(i)}" y="${panelR.y + panelR.h - 12}" font-family="${SERIF}" font-size="22" fill="${OLIVE}" text-anchor="middle">L${lv}</text>`,
  )
  .join("");

const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}">
  <rect width="${W2}" height="${H2}" fill="#FBF6EA"/>
  <text x="70" y="64" font-family="${CJK}" font-size="38" font-weight="bold" fill="${INK}">难度递增下的开发成功率与每次成功成本</text>
  <text x="70" y="106" font-family="${CJK}" font-size="21" fill="${OLIVE}">5 档难度 × 3 种方法 · 每格 5000 次蒙特卡洛 · 成本以 ATLAS = 1.0× 归一化</text>
  ${axis(panelL, "开发成功率")}
  ${axis(panelR, "每次成功成本（指数）")}
  ${ticks}
  ${xlabels}
  ${succ(general, RED)}
  ${succ(modules, GREEN)}
  ${succ(atlas, NAVY)}
  ${cost(general, RED)}
  ${cost(modules, GREEN)}
  ${cost(atlas, NAVY)}
  <g font-family="${SERIF}" font-size="21">
    <line x1="${panelL.x}" y1="${H2 - 50}" x2="${panelL.x + 40}" y2="${H2 - 50}" stroke="${RED}" stroke-width="3.5"/>
    <text x="${panelL.x + 52}" y="${H2 - 42}" fill="${OLIVE}">General AI</text>
    <line x1="${panelL.x + 210}" y1="${H2 - 50}" x2="${panelL.x + 250}" y2="${H2 - 50}" stroke="${GREEN}" stroke-width="3.5"/>
    <text x="${panelL.x + 262}" y="${H2 - 42}" fill="${OLIVE}">AI + Capability Modules</text>
    <line x1="${panelL.x + 570}" y1="${H2 - 50}" x2="${panelL.x + 610}" y2="${H2 - 50}" stroke="${NAVY}" stroke-width="3.5"/>
    <text x="${panelL.x + 622}" y="${H2 - 42}" fill="${OLIVE}">ATLAS</text>
  </g>
</svg>`;
writeFileSync(`${CHARTS}/difficulty-curve.svg`, chart);

await sharp(Buffer.from(poster)).png().toFile(`${CHARTS}/poster-comparison.png`);
await sharp(Buffer.from(chart)).png().toFile(`${CHARTS}/difficulty-curve.png`);
console.log("figures written");







