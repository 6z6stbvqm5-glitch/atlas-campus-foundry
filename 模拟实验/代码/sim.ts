/**
 * ATLAS 代码块 × Agent 开发成功率 / 成本 估算实验
 * 真实输入：packages/modules/src/catalog.ts 的模块清单（依赖闭包、配置字段）
 * 显式假设：三方法的 sigmoid 成功率、步数、上下文增长、DeepSeek 量级单价
 * 抽样：每格 5000 次 Monte Carlo
 */
import { catalog, resolveModules } from "../../packages/modules/src/catalog.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..");
const DATA_DIR = resolve(OUT_DIR, "数据");
const DOC_DIR = resolve(OUT_DIR, "报告");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DOC_DIR, { recursive: true });

// ---------------- 1. 任务集：5 档难度（外生难度档，W 为客观复杂度读数） ----------------
type Task = {
  level: number; name: string; desc: string;
  modules: string[]; edges: number; customCode: boolean;
};
const tasks: Task[] = [
  { level: 1, name: "L1 单记录应用", desc: "课程笔记：1 块记录模块 + 列表", modules: ["course-notes"], edges: 0, customCode: false },
  { level: 2, name: "L2 双块联动", desc: "作业清单 + 状态看板", modules: ["assignments", "board-view"], edges: 1, customCode: false },
  { level: 3, name: "L3 三块 + 视图/检索", desc: "论坛 + 卡片视图 + 关键词搜索", modules: ["discussion-forum", "card-view", "keyword-search"], edges: 3, customCode: false },
  { level: 4, name: "L4 编排自动化", desc: "作业 + 触发/条件/通知 + 看板（6 条连线）", modules: ["assignments", "when-updated", "status-condition", "notify-author", "board-view"], edges: 6, customCode: false },
  { level: 5, name: "L5 自定义代码", desc: "失物招领 + 内嵌区 + 留痕 + src/feature.ts", modules: ["lost-found", "embedded-list", "audit-entry", "notify-author"], edges: 4, customCode: true },
];

const work = tasks.map((t) => {
  const mods = resolveModules(t.modules, catalog);
  const fields = mods.reduce((a, m) => a + (m.configurationFields?.length ?? 0), 0);
  const files = t.customCode ? 4 : t.level >= 4 ? 3 : 2;
  const W = 0.5 * mods.length + 0.3 * t.edges + 0.12 * fields + 1.1 * files + (t.customCode ? 2 : 0);
  return { ...t, n: mods.length, fields, files, W, moduleIds: mods.map((m) => m.moduleId) };
});

// ---------------- 2. 三方法 ---------------- 
const methods = [
  { key: "general", label: "General AI", alpha: 1.35, beta: 0.55,
    ctxBase: 1500, growth: 230, stepBase: 9, stepPerFile: 1.6, stepPerModule: 1.2, failFactor: 0.62 },
  { key: "modules", label: "AI + Capability Modules", alpha: 2.00, beta: 0.52,
    ctxBase: 1780, growth: 190, stepBase: 7, stepPerFile: 1.1, stepPerModule: 1.3, failFactor: 0.58 },
  { key: "atlas", label: "ATLAS", alpha: 3.20, beta: 0.45,
    ctxBase: 1850, growth: 130, stepBase: 4, stepPerFile: 0.8, stepPerModule: 1.2, failFactor: 0.55 },
] as const;

const STEP_BUDGET = 18;              // docs/AGENT_GUIDE.md: 默认最多 18 步
const OVER_BUDGET_PENALTY = 0.22;    // 每超 1 步对成功率取的对数惩罚
const CUSTOM_CODE_TOKEN_EXTRA = 5200; // runBuild + runTests + Docker 日志读取
const CUSTOM_CODE_LOGIT_PENALTY = 0.35; // ENABLE_CUSTOM_CODE=false 的门禁失败面
const PRICE_IN = 0.28 / 1e6, PRICE_OUT = 0.42 / 1e6, OUT_SHARE = 0.15;
const USD_PER_TOKEN = PRICE_IN * (1 - OUT_SHARE) + PRICE_OUT * OUT_SHARE;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function stepsOf(m: (typeof methods)[number], w: (typeof work)[number]) {
  const need = m.stepBase + m.stepPerFile * w.files + m.stepPerModule * w.n;
  return { need, actual: Math.min(STEP_BUDGET, need) };
}
function tokensOf(m: (typeof methods)[number], actualSteps: number, w: (typeof work)[number]) {
  let t = 0;
  for (let i = 1; i <= Math.round(actualSteps); i++) t += m.ctxBase + m.growth * i;
  if (w.customCode) t += CUSTOM_CODE_TOKEN_EXTRA * (m.key === "atlas" ? 1 : 1.6);
  return Math.round(t);
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = 5000;
const plan = [4, 4, 4, 3, 3]; // 每档尝试次数，合计 18

const results = methods.map((m) => {
  const perLevel = work.map((w) => {
    const { need, actual } = stepsOf(m, w);
    const over = Math.max(0, need - STEP_BUDGET);
    const p = sigmoid(
      m.alpha - m.beta * w.level - OVER_BUDGET_PENALTY * over - (w.customCode ? CUSTOM_CODE_LOGIT_PENALTY : 0),
    );
    const tokens = tokensOf(m, actual, w);
    let succ = 0, spent = 0, succSpent = 0;
    const rnd = mulberry32(700 + w.level * 131 + m.key.length * 17);
    for (let i = 0; i < TRIALS; i++) {
      const ok = rnd() < p;
      const s = ok ? tokens : tokens * m.failFactor;
      spent += s;
      if (ok) { succ++; succSpent += s; }
    }
    return {
      level: w.level, W: +w.W.toFixed(2), n: w.n, edges: w.edges, files: w.files,
      needSteps: +need.toFixed(1), actualSteps: Math.round(actual),
      p_measured: +(succ / TRIALS).toFixed(3),
      tokens_per_run: tokens,
      usd_per_run: +(tokens * USD_PER_TOKEN).toFixed(5),
      tokens_per_success: succ ? Math.round(spent / succ) : null,
      usd_per_success: succ ? +((spent / succ) * USD_PER_TOKEN).toFixed(5) : null,
    };
  });

  // 18 次尝试账面（档内按抽样率整数化，避免期望值小数）
  const byLevel = new Map(perLevel.map((r) => [r.level, r]));
  let attempts = 0, successes = 0, spend = 0;
  const runs: { level: number; ok: boolean; tokens: number }[] = [];
  plan.forEach((cnt, idx) => {
    const r = byLevel.get(idx + 1)!;
    const okCount = Math.round(r.p_measured * cnt);
    for (let i = 0; i < cnt; i++) {
      const ok = i < okCount;
      const spentThis = ok ? r.tokens_per_run : Math.round(r.tokens_per_run * m.failFactor);
      attempts++; spend += spentThis;
      if (ok) successes++;
      runs.push({ level: idx + 1, ok, tokens: spentThis });
    }
  });
  return {
    key: m.key, method: m.label, params: { alpha: m.alpha, beta: m.beta },
    perLevel,
    summary: {
      attempts, successes, successRate: +(successes / attempts).toFixed(3),
      total_tokens: spend,
      total_usd: +(spend * USD_PER_TOKEN).toFixed(4),
      tokens_per_success: successes ? Math.round(spend / successes) : null,
      usd_per_success: successes ? +((spend / successes) * USD_PER_TOKEN).toFixed(5) : null,
    },
    runs,
  };
});

// 归一化：ATLAS 每次成功成本 = 1.0
const atlasCps = results.find((r) => r.key === "atlas")!.summary.usd_per_success!;
for (const r of results) {
  (r.summary as any).cost_index = +(r.summary.usd_per_success! / atlasCps).toFixed(2);
  for (const l of r.perLevel) (l as any).cost_index = +(l.usd_per_success! / atlasCps).toFixed(2);
}

const payload = {
  generatedAt: new Date().toISOString(),
  assumptions: {
    price_usd_per_million: { input: 0.28, output: 0.42, outputShare: OUT_SHARE },
    usd_per_token: USD_PER_TOKEN,
    trialsPerCell: TRIALS,
    stepBudget: STEP_BUDGET, overBudgetPenalty: OVER_BUDGET_PENALTY,
    attemptsPerLevel: plan,
    workFormula: "W = 0.5*modules + 0.3*edges + 0.12*configFields + 1.1*files (+2 customCode)",
    note: "成功率与 token 为显式假设 + Monte Carlo，非真实 LLM 调用结果",
  },
  work, results,
};
writeFileSync(`${DATA_DIR}/simulation-results.json`, JSON.stringify(payload, null, 2));

// ---------------- 3. Markdown ---------------- 
const md: string[] = [];
md.push("# ATLAS 代码块 × Agent：开发成功率与成本估算实验\n");
md.push("> 难度 5 档逐级递增；每档每方法 5000 次 Monte Carlo；18 次尝试账面与海报口径一致。\n");
md.push("## 任务集与客观复杂度（由 catalog.ts 真实依赖闭包计算）\n");
md.push("| 档位 | 任务 | 解析后模块数 | 编排边 | 配置文件 | 难度 W |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const w of work) md.push(`| L${w.level} | ${w.desc} | ${w.n} | ${w.edges} | ${w.files} | ${w.W.toFixed(2)} |`);
md.push("\n## 逐档成功率\n");
md.push("| 档位 | " + results.map((r) => r.method).join(" | ") + " |");
md.push("| --- | " + results.map(() => "---").join(" | ") + " |");
for (let i = 0; i < work.length; i++)
  md.push(`| L${work[i].level} | ` + results.map((r) => (r.perLevel[i].p_measured * 100).toFixed(1) + "%").join(" | ") + " |");
md.push("\n## 逐档每次成功成本（USD / 归一化指数）\n");
md.push("| 档位 | " + results.map((r) => r.method).join(" | ") + " |");
md.push("| --- | " + results.map(() => "---").join(" | ") + " |");
for (let i = 0; i < work.length; i++)
  md.push(`| L${work[i].level} | ` + results.map((r) => `$${r.perLevel[i].usd_per_success} / ${r.perLevel[i].cost_index}×`).join(" | ") + " |");
md.push("\n## 18 次尝试汇总（海报口径）\n");
md.push("| 方法 | 成功构建 | 成功率 | 总 token | 总成本 | 每次成功 token | 每次成功成本 | 成本指数 |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of results)
  md.push(`| ${r.method} | ${r.summary.successes} / ${r.summary.attempts} | ${(r.summary.successRate * 100).toFixed(0)}% | ${r.summary.total_tokens.toLocaleString()} | $${r.summary.total_usd} | ${r.summary.tokens_per_success.toLocaleString()} | $${r.summary.usd_per_success} | ${r.summary.cost_index}× |`);
writeFileSync(`${DOC_DIR}/blocks-experiment.md`, md.join("\n") + "\n");

console.log("workload:");
for (const w of work) console.log(`  L${w.level} n=${w.n} e=${w.edges} fields=${w.fields} files=${w.files} W=${w.W.toFixed(2)}`);
console.log("");
for (const r of results) {
  console.log(`== ${r.method}: ${r.summary.successes}/${r.summary.attempts} (${(r.summary.successRate*100).toFixed(0)}%)  total=$${r.summary.total_usd}  ${r.summary.tokens_per_success} tok/succ  $${r.summary.usd_per_success}  idx=${r.summary.cost_index}x`);
  for (const l of r.perLevel) console.log(`   L${l.level} steps=${l.needSteps}->${l.actualSteps} p=${l.p_measured} tok/run=${l.tokens_per_run} cost/succ $${l.usd_per_success} (${l.cost_index}x)`);
}


