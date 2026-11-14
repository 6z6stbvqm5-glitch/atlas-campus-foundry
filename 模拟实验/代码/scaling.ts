/**
 * 同比放大实验：把难度整体放大 k 倍（模块数 / 编排边 / 配置文件全等比例放大），
 * 看成功率与成本怎么走，以及在「默认 18 步」和「硬上限 40 步」两种预算下分别是什么结局。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const DATA_DIR = resolve(OUT, "数据");
const DOC_DIR = resolve(OUT, "报告");
const TRIALS = 5000;
const PRICE_IN = 0.28 / 1e6;
const PRICE_OUT = 0.42 / 1e6;
const OUT_SHARE = 0.15;
const USD_PER_TOKEN = PRICE_IN * (1 - OUT_SHARE) + PRICE_OUT * OUT_SHARE;
const CUSTOM_CODE_TOKEN_EXTRA = 5200;
const CUSTOM_CODE_LOGIT_PENALTY = 0.35;

type Task = { key: string; label: string; n: number; e: number; fields: number; files: number; customCode: boolean };

// 基准任务集（与 1× 实验完全一致）
const BASE: Task[] = [
  { key: "L1", label: "课程笔记", n: 2, e: 0, fields: 2, files: 2, customCode: false },
  { key: "L2", label: "作业清单+看板", n: 3, e: 1, fields: 2, files: 2, customCode: false },
  { key: "L3", label: "论坛+视图+搜索", n: 5, e: 3, fields: 2, files: 2, customCode: false },
  { key: "L4", label: "作业+触发+通知", n: 7, e: 6, fields: 3, files: 3, customCode: false },
  { key: "L5", label: "失物招领+自定义码", n: 6, e: 4, fields: 4, files: 4, customCode: true },
];
// 每档在 18 次账面里的出现次数
const PLAN = [4, 4, 4, 3, 3];

const scaleTask = (t: Task, k: number): Task => ({
  ...t,
  n: Math.round(t.n * k),
  e: Math.round(t.e * k),
  fields: Math.round(t.fields * k),
  files: Math.max(1, Math.round(t.files * k)),
});

const W_of = (t: Task) =>
  0.5 * t.n + 0.3 * t.e + 0.12 * t.fields + 1.1 * t.files + (t.customCode ? 2 : 0);

// level 校准：L1@1× 的 W=3.20 记为 level 1.0；放大后难度按 W 等比外推
const LEVEL_UNIT = 3.2;

const methods = [
  { key: "general", name: "General AI", alpha: 1.35, beta: 0.55, ctxBase: 1500, growth: 230, stepBase: 9, stepPerFile: 1.6, stepPerModule: 1.2, failFactor: 0.62 },
  { key: "modules", name: "AI + Capability Modules", alpha: 2.0, beta: 0.52, ctxBase: 1780, growth: 190, stepBase: 7, stepPerFile: 1.1, stepPerModule: 1.3, failFactor: 0.58 },
  { key: "atlas", name: "ATLAS", alpha: 3.2, beta: 0.45, ctxBase: 1850, growth: 130, stepBase: 4, stepPerFile: 0.8, stepPerModule: 1.2, failFactor: 0.55 },
  { key: "atlas_batch", name: "ATLAS（批量提交多块）", alpha: 3.2, beta: 0.45, ctxBase: 1850, growth: 130, stepBase: 4, stepPerFile: 0.8, stepPerModule: 0.35, failFactor: 0.55 },
];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

const needSteps = (m: typeof methods[number], t: Task) =>
  m.stepBase + m.stepPerFile * t.files + m.stepPerModule * t.n;

const tokensOf = (m: typeof methods[number], steps: number, t: Task) => {
  let tok = 0;
  for (let i = 1; i <= Math.round(steps); i++) tok += m.ctxBase + m.growth * i;
  if (t.customCode) tok += CUSTOM_CODE_TOKEN_EXTRA * (m.key === "atlas" ? 1 : 1.6);
  return Math.round(tok);
};

// 一次尝试：返回 [success, tokensUsed]
const runOne = (m: typeof methods[number], t: Task, budget: number) => {
  const need = needSteps(m, t);
  const level = (["L1","L2","L3","L4","L5"].indexOf(t.key) + 1) * (t.__k ?? 1);
  const over = Math.max(0, need - budget);
  const p = sigmoid(
    m.alpha - m.beta * level - 0.22 * over - (t.customCode ? CUSTOM_CODE_LOGIT_PENALTY : 0),
  );
  const capped = Math.min(need, budget);
  const actual = Math.min(capped, Math.ceil(capped * m.failFactor + 1)); // 失败提前中断
  const tokens = tokensOf(m, actual, t);
  return { ok: Math.random() < p, p, tokens, need, level };
};

const cell = (m: typeof methods[number], t: Task, budget: number) => {
  let ok = 0, tokSum = 0, pSum = 0, needSum = 0;
  for (let i = 0; i < TRIALS; i++) {
    const r = runOne(m, t, budget);
    if (r.ok) ok++;
    tokSum += r.tokens;
    pSum += r.p;
    needSum += r.need;
  }
  return {
    p: pSum / TRIALS,
    okRate: ok / TRIALS,
    tokPerRun: Math.round(tokSum / TRIALS),
    needSteps: +(needSum / TRIALS).toFixed(1),
  };
};

const KS = [1, 2, 3, 4, 6];
const BUDGETS = [18, 40];

const perScale: any[] = [];
for (const k of KS) {
  const tasks = BASE.map((t) => ({ ...scaleTask(t, k), __k: k }));
  for (const budget of BUDGETS) {
    for (const m of methods) {
      if (m.key === "atlas_batch" && budget !== 18) continue;
      let wins = 0, total = 0, tokTotal = 0, pWeighted = 0, needWeighted = 0, tokPerTask = 0;
      const detail = tasks.map((t, i) => {
        const c = cell(m, t, budget);
        const runs = PLAN[i];
        total += runs;
        tokTotal += c.tokPerRun * runs;
        tokPerTask += c.tokPerRun * runs;
        needWeighted += c.needSteps * runs;
        pWeighted += c.p * runs;
        let taskWins = 0;
        for (let r = 0; r < runs; r++) {
          const x = runOne(m, t, budget);
          if (x.ok) taskWins++;
        }
        wins += taskWins;
        return {
          key: t.key,
          label: t.label,
          modules: t.n,
          edges: t.e,
          files: t.files,
          W: +W_of(t).toFixed(2),
          level: (["L1","L2","L3","L4","L5"].indexOf(t.key) + 1) * k,
          needSteps: c.needSteps,
          p: +c.p.toFixed(4),
          tokPerRun: c.tokPerRun,
          wins: taskWins,
          runs,
        };
      });
      const pMeanAll = pWeighted / total; const winsExp = pMeanAll * total; 
      const usdPerSuccess = winsExp > 0 ? (tokTotal * USD_PER_TOKEN) / winsExp : Infinity;
      perScale.push({
        k,
        budget,
        method: m.key,
        methodName: m.name,
        successes: Math.round((pWeighted / total) * total),
        attempts: total,
        winRate: +(pWeighted / total).toFixed(4),
        pMean: +(pWeighted / total).toFixed(4),
        needStepsMean: +(needWeighted / total).toFixed(1),
        totalTokens: Math.round(tokTotal),
        totalUsd: +(tokTotal * USD_PER_TOKEN).toFixed(4),
        tokPerSuccess: winsExp > 0 ? Math.round(tokTotal / winsExp) : null,
        usdPerSuccess: winsExp > 0 ? +usdPerSuccess.toFixed(5) : null,
        detail,
      });
    }
  }
}

// 成本指数：以 ATLAS @ k=1 的每次成功成本为 1.00×
const baseline = perScale.find((r) => r.k === 1 && r.budget === 40 && r.method === "atlas")!.usdPerSuccess!;
for (const r of perScale) {
  r.costIndex = r.usdPerSuccess && r.successes >= 1 ? +(r.usdPerSuccess / baseline).toFixed(2) : null;
}

// 规模画像（放大到什么量级）
const profile: Record<number, string> = {
  1: "小应用：5 块内 / 4 文件内（当前 demo 规模）",
  2: "中应用：~14 块 / 8 文件（完整社团平台）",
  3: "中大应用：~21 块 / 12 文件（校园二手交易全链路）",
  4: "大应用：~28 块 / 16 文件（多角色多空间 SaaS）",
  6: "超大应用：~42 块 / 24 文件（垂直行业平台）",
};

writeFileSync(
  `${DATA_DIR}/scaling-results.json`,
  JSON.stringify({ assumptions: { TRIALS, KS, BUDGETS, USD_PER_TOKEN, LEVEL_UNIT, profile }, results: perScale }, null, 2),
);

// ---- markdown ----
const pick = (k: number, budget: number, m: string) =>
  perScale.find((r) => r.k === k && r.budget === budget && r.method === m)!;

const head = ["k", "规模", "方法", "成功/尝试", "成功率", "平均需要步数", "总 token", "每次成功 token", "每次成功成本", "成本指数"];
const line = (k: number, budget: number, m: string) => {
  const r = pick(k, budget, m);
  const feasible = r.successes >= 1;
  const tokS = feasible ? r.tokPerSuccess.toLocaleString("en-US") : "—";
  const usdS = feasible ? "$" + r.usdPerSuccess.toFixed(4) : "—（不可行）";
  const idxS = r.costIndex ? r.costIndex.toFixed(2) + "×" : "发散";
  return `| ${k}× | ${profile[k].split("：")[0]} | ${r.methodName} | ${r.successes} / ${r.attempts} | ${(r.winRate * 100).toFixed(0)}% | ${r.needStepsMean} | ${r.totalTokens.toLocaleString("en-US")} | ${tokS} | ${usdS} | ${idxS} |`;
};

let md = `# 同比放大实验：难度 ×k 之后会发生什么

> 把模块数、编排边、配置字段、文件数**全部等比例放大 k 倍**（不是加一项，而是整体放大），
> 其余假设与 1× 实验完全一致。每格 5000 次蒙特卡洛，18 次账面口径不变（4/4/4/3/3）。

## 规模画像

| k | 规模 | 典型任务 |
| --- | --- | --- |
${KS.map((k) => `| ${k}× | ${profile[k].split("：")[0]} | ${profile[k].split("：")[1]} |`).join("\n")}

## 预算 A：默认 18 步（现状配置 LLM_MAX_STEPS=18）

| ${head.join(" | ")} |
| ${head.map(() => "---").join(" | ")} |
${KS.flatMap((k) => methods.map((m) => line(k, 18, m.key))).join("\n")}

## 预算 B：硬上限 40 步（docs/AGENT_GUIDE.md 的 40 步硬顶）

| ${head.join(" | ")} |
| ${head.map(() => "---").join(" | ")} |
${KS.flatMap((k) => methods.filter((m) => m.key !== "atlas_batch").map((m) => line(k, 40, m.key))).join("\n")}

## 逐档明细（k=3×，40 步预算）

| 基准档 | 放大后模块 | 边 | 文件 | W | 等效难度 | 需要步数 | 通用 p | 模块 p | ATLAS p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${BASE.map((t, i) => {
  const s = scaleTask(t, 3);
  const gp = pick(3, 40, "general").detail[i];
  const mp = pick(3, 40, "modules").detail[i];
  const ap = pick(3, 40, "atlas").detail[i];
  return `| ${t.key} ${t.label} | ${s.n} | ${s.e} | ${s.files} | ${W_of(s).toFixed(2)} | ${(W_of(s) / LEVEL_UNIT).toFixed(2)} | ${ap.needSteps}（ATLAS） | ${(gp.p * 100).toFixed(0)}% | ${(mp.p * 100).toFixed(0)}% | ${(ap.p * 100).toFixed(0)}% |`;
}).join("\n")}
`;

writeFileSync(`${DOC_DIR}/scaling-experiment.md`, md);
console.log(md);







