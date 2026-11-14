/**
 * 校准锚点：真实调用 deepseek-chat，测量 ATLAS agent 一轮的 prompt token 量级。
 * 用途：验证蒙特卡洛模型里 ctxBase / growth 的假设是否离谱。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DATA_DIR = resolve(HERE, "../数据");
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const BASE = env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const KEY = env.LLM_API_KEY;
const MODEL = env.LLM_MODEL ?? "deepseek-chat";

const agentSrc = readFileSync(`${ROOT}/server/agent.ts`, "utf8");
const guide = readFileSync(`${ROOT}/docs/AGENT_GUIDE.md`, "utf8");
const schemasBlock = agentSrc.slice(agentSrc.indexOf("const toolSchemas = {"), agentSrc.indexOf("const toolOutputSchemas"));
const descBlock = agentSrc.slice(agentSrc.indexOf("const descriptions: Record"), agentSrc.indexOf("export const toolDefinitions"));

const SYSTEM = [
  "你是 ATLAS 应用装配 Agent。你只能通过工具操作项目，不允许输出自由代码。",
  guide,
  "可用工具（名称 → 参数契约）：",
  schemasBlock,
  "工具说明：",
  descBlock,
].join("\n\n");

const SPECS = {
  L1: "为校园二手交易场景建一个「课程笔记」应用：只需要 course-notes 模块，字段 title/courseCode/body，列表用卡片视图。",
  L3: "建一个「课程讨论区」应用：discussion-forum + card-view + keyword-search，帖子字段 title/body/tags，支持关键字搜索与卡片展示，学生可发帖回帖。",
  L5: "建一个「失物招领」应用：lost-found + embedded-list + audit-entry + notify-author，并在 writeProjectFiles 里加自定义聚合统计页面（需要 runBuild/runTests 验证）。",
};

const call = async (spec: string) => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: spec },
      ],
      max_tokens: 120,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json: any = await res.json();
  return {
    prompt_tokens: json.usage.prompt_tokens,
    completion_tokens: json.usage.completion_tokens,
    total_tokens: json.usage.total_tokens,
    replyHead: String(json.choices?.[0]?.message?.content ?? "").slice(0, 120),
  };
};

const out: any = { model: MODEL, base: BASE, systemChars: SYSTEM.length, specs: {} };
for (const [k, v] of Object.entries(SPECS)) {
  out.specs[k] = await call(v);
  out.specs[k].specChars = v.length;
}
out.observedPromptTokens = Object.fromEntries(Object.entries(out.specs).map(([k, v]: any) => [k, v.prompt_tokens]));
writeFileSync(`${DATA_DIR}/calibration.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

