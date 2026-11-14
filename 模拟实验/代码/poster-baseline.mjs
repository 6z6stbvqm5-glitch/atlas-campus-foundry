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
const NAVY = "#0C1A33";
const OLIVE = "#6B5B3E";
const RULE = "#8A7A57";
const SERIF = "Georgia, 'Times New Roman', serif";
const CJK = "'Microsoft YaHei', 'PingFang SC', sans-serif";

// 难度档位权重（18 次账面：L1..L5 = 4/4/4/3/3）
const PLAN = [4, 4, 4, 3, 3];
// 失败格底色 = 难度轴上的位置：18 格线性插值（深 → 浅），无色阶跳变
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TRACK_A = hex("#DDC79B");
const TRACK_B = hex("#F3E9D3");
const bgFor = (i) => {
  const t = i / 17;
  const c = TRACK_A.map((v, k) => Math.round(v + (TRACK_B[k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
const TIER_NAME = ["L1", "L2", "L3", "L4", "L5"];
const BASE_P = (g("general").perLevel || []).map((l) => (l.p_measured * 100).toFixed(0) + "%");

// 排序：成功全部前置，其后失败按难度升序 —— 整条从“做得出”平滑过渡到“做不出”，没有断裂点
// 第一行（General AI）定义难度轴 → 必须单调：成功的排左、失败排右，整条无断裂。
// 其余两行保留真实顺序，允许出现“低难度失败 / 高难度成功”的断点——这正是模块库覆盖不全时的真实形态。
const ordered = (runs, mono) => {
  const tagged = runs.map((r, di) => ({ ...r, di }));
  if (!mono) return tagged;
  const wins = tagged.filter((r) => r.ok);
  const fails = tagged.filter((r) => !r.ok);
  return [...wins, ...fails];
};

const W = 1600;
const H = 800;
const rows = [
  { label: "General AI", res: general, y: 250, mono: true },
  { label: "AI + Capability Modules", res: modules, y: 340 },
  { label: "ATLAS", res: atlas, y: 440, accent: true },
];
const barX = 470;
const cellW = 26;
const cellH = 20;
const gap = 4;
const groupGap = 10;

const xOf = (i) => barX + i * (cellW + gap);

const barsFor = (res, yBase, accent, mono) => {
  const orderedRuns = ordered(res.runs, mono);
  let s = "";
  orderedRuns.forEach((r, i) => {
    const x = xOf(i);
    const y = yBase - cellH;
    if (r.ok) {
      s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${GOLD}"/>`;
    } else {
      s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${bgFor(r.di)}"/>`;
      s += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${cellW - 1}" height="${cellH - 1}" fill="none" stroke="${accent ? "#4A5C7A" : "#CFBA92"}" stroke-width="1"/>`;
    }
  });
  return s;
};

const rowSvg = rows
  .map((r) => {
    const block = r.accent ? `<rect x="40" y="${r.y - 64}" width="1032" height="122" fill="${NAVY}"/>` : "";
    const labelColor = r.accent ? "#F7EFDD" : INK;
    const subColor = OLIVE;
    const numColor = r.accent ? "#F7EFDD" : INK;
    return `${block}
    <text x="72" y="${r.y}" font-family="${SERIF}" font-size="34" fill="${labelColor}">${r.label}</text>
    <text x="${barX}" y="${r.y - 38}" font-family="${SERIF}" font-size="29" font-weight="bold" fill="${numColor}">${r.res.summary.successes} / 18</text>
    ${barsFor(r.res, r.y + 4, r.accent, r.mono)}
    <text x="1082" y="${r.y - 6}" font-family="${SERIF}" font-size="30" font-style="italic" fill="${subColor}">$${r.res.summary.usd_per_success.toFixed(3)}</text>
    <text x="1082" y="${r.y + 26}" font-family="${SERIF}" font-size="20" fill="${subColor}">${r.res.summary.cost_index.toFixed(2)}× baseline</text>`;
  })
  .join("");

// 难度轴注记（不再把档位标签贴在格子上，因为整条已按“先成功、后失败”重排）
const tierLabels = (() => {
  const xs = xOf(0);
  const xe = xOf(17) + cellW;
  let s = "";
  s += `<line x1="${xs}" y1="520" x2="${xe - 12}" y2="520" stroke="${OLIVE}" stroke-width="1.4"/>`;
  s += `<path d="M ${xe - 12} 515 L ${xe} 520 L ${xe - 12} 525 Z" fill="${OLIVE}"/>`;
  s += `<text x="${xs}" y="546" font-family="${SERIF}" font-size="19" fill="${OLIVE}">easy</text>`;
  s += `<text x="${xe}" y="546" font-family="${SERIF}" font-size="19" fill="${OLIVE}" text-anchor="end">hard</text>`;
  s += `<text x="70" y="520" font-family="${SERIF}" font-size="17" fill="${OLIVE}">difficulty axis</text>`;
  s += `<text x="70" y="546" font-family="${SERIF}" font-size="16" fill="${OLIVE}">defined by the baseline</text>`;
  s += `<text x="70" y="576" font-family="${SERIF}" font-size="16" fill="${OLIVE}">General-AI success rate:</text>`;
  s += `<text x="70" y="598" font-family="${SERIF}" font-size="16" fill="${OLIVE}">L1 ${BASE_P[0]} · L2 ${BASE_P[1]} · L3 ${BASE_P[2]} · L4 ${BASE_P[3]} · L5 ${BASE_P[4]}</text>`;
  return s;
})();

const grid = Array.from({ length: 12 }, (_, i) => `<line x1="${(i + 1) * 130}" y1="0" x2="${(i + 1) * 130}" y2="${H}"/>`).join("");

const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BONE}"/>
  <g opacity="0.28" stroke="#DCCBAA" stroke-width="1">${grid}</g>
  <text x="60" y="80" font-family="${SERIF}" font-size="48" font-weight="bold" fill="${INK}">Comparative Evaluation: Build Success and Cost</text>
  <line x1="60" y1="116" x2="${W - 60}" y2="116" stroke="${RULE}" stroke-width="2"/>
  <text x="60" y="166" font-family="${SERIF}" font-size="28" font-weight="bold" fill="${INK}">Method</text>
  <text x="${barX}" y="166" font-family="${SERIF}" font-size="27" font-weight="bold" fill="${INK}">Attempts by difficulty</text>
  <text x="1070" y="166" font-family="${SERIF}" font-size="28" font-weight="bold" fill="${INK}">Cost per Success</text>
  <line x1="60" y1="186" x2="${W - 60}" y2="186" stroke="${RULE}" stroke-width="1.5"/>
  ${rowSvg}
  ${tierLabels}

  <rect x="560" y="600" width="20" height="15" fill="${GOLD}"/>
  <text x="588" y="613" font-family="${SERIF}" font-size="18" fill="${OLIVE}">successful build</text>
  <rect x="726" y="600" width="20" height="15" fill="#EBDDC0"/>
  <rect x="726.5" y="600.5" width="19" height="14" fill="none" stroke="#CFBA92" stroke-width="1"/>
  <text x="754" y="613" font-family="${SERIF}" font-size="18" fill="${OLIVE}">failed attempt (shade = difficulty)</text>

  <line x1="70" y1="646" x2="150" y2="646" stroke="${RULE}" stroke-width="1"/>
  <text x="70" y="672" font-family="${SERIF}" font-size="17" fill="${OLIVE}">Same requirement set · same model (deepseek-chat) · 18 attempts per method · 5000 trials per cell</text>
  <text x="70" y="696" font-family="${SERIF}" font-size="17" fill="${OLIVE}">row 1 is sorted solved-first because it defines the axis; rows 2–3 keep the raw order</text>
  <text x="70" y="720" font-family="${SERIF}" font-size="17" fill="${OLIVE}">a gap in rows 2–3 = a simpler build failed while a harder one passed (library was missing that block)</text>
  <text x="70" y="744" font-family="${SERIF}" font-size="17" fill="${OLIVE}">cost = USD per successful build · est. by Monte Carlo over 5 difficulty levels</text>

  <g opacity="0.85">
    <path d="M 1400 ${H - 30} A 210 210 0 0 1 1595 ${H - 240}" fill="none" stroke="${RULE}" stroke-width="2"/>
    <path d="M 1420 ${H - 30} A 190 190 0 0 1 1595 ${H - 220}" fill="none" stroke="${RULE}" stroke-width="1.5"/>
    <path d="M 1440 ${H - 30} A 170 170 0 0 1 1595 ${H - 200}" fill="none" stroke="${RULE}" stroke-width="1"/>
  </g>
  <text x="1112" y="${H - 232}" font-family="${SERIF}" font-size="126" font-weight="bold" fill="${OLIVE}">${(atlas.summary.successes / general.summary.successes).toFixed(1)}×</text>
  <text x="1150" y="${H - 176}" font-family="${SERIF}" font-size="30" fill="${OLIVE}">successful builds</text>
  <text x="1150" y="${H - 142}" font-family="${SERIF}" font-size="23" fill="${OLIVE}">VS. GENERAL-AI BASELINE</text>
</svg>`;
writeFileSync(`${CHARTS}/poster-baseline.svg`, poster);
await sharp(Buffer.from(poster)).png().toFile(`${CHARTS}/poster-baseline.png`);
console.log("poster-baseline written");
















