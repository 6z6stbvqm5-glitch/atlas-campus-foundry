# 模型路由接口契约 v0.1

- 文档编号：ATLAS-API-001
- 版本：v0.1（待评审冻结）
- 日期：2026-11-09
- 实现方：X6 路由工程师
- 冻结后规则：字段名、类型、错误码不得再改；只能新增可选字段

## 1. 目标

按开发难度自动选择模型档位，降低「简单任务用贵模型」的浪费；同时把每次任务的 token 与成本落到可查询的地方——它既是成本控制的基础，也是实验取数的唯一数据源。

两条硬要求：

1. **向后兼容**：只配了一个模型时，行为必须与现在完全一致（等价于 `auto` 恒选该模型）。
2. **可观测**：任何一次任务都能回答「用了哪个模型、花了多少 token、折多少钱」。

## 2. 现状与必须改动的地方

| 现状 | 位置 | 结论 |
| --- | --- | --- |
| 单一模型配置存 `platform_settings`（`llm` 键） | `server/llm-config.ts` | 保留，作为基线；档位表新增独立表 |
| `LlmProvider.complete(): Promise<LlmMessage>` | `server/agent.ts:29` | **必须改**：返回值丢弃了 `usage` 与 `model` |
| `jobs` 表无模型与 token 字段 | `migrations/control/001_initial.sql` | **必须加列** |
| agent 每轮调用 `this.provider.complete(...)` | `server/agent.ts:702` | 在此累加 usage |

## 3. 数据模型

### 3.1 `model_profiles`（新增表）

```sql
CREATE TABLE IF NOT EXISTS model_profiles (
  id text PRIMARY KEY,
  tier text NOT NULL,                 -- economy | balanced | premium
  label text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_enc text,                   -- vault 加密；为空则回落 .env 的 LLM_API_KEY
  price_in numeric(12,6) NOT NULL DEFAULT 0,   -- 每百万输入 token 单价（USD）
  price_out numeric(12,6) NOT NULL DEFAULT 0,  -- 每百万输出 token 单价（USD）
  enabled boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 3.2 `jobs` 增列

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS used_profile_id text,
  ADD COLUMN IF NOT EXISTS used_model text,
  ADD COLUMN IF NOT EXISTS tokens_input integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_output integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS routing jsonb;
```

`routing` 结构：`{ "policy": "auto", "tier": "balanced", "profileId": "p-1", "score": 0.62, "reasons": ["modules=12", "customFields=3"], "estimatedTokens": 18400, "estimatedCostUsd": 0.0041 }`

## 4. 接口

### 4.1 档位管理（admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/models` | 返回 `{ profiles: ModelProfile[], policy: RoutePolicy, thresholds: {...} }`；任意登录用户可读，`api_key_enc` 永远不出现在响应里，只给 `hasKey: boolean` |
| PUT | `/api/system/models` | 整表 upsert（body: `{ profiles, policy, thresholds }`）；审计 `system.models_updated` |
| DELETE | `/api/system/models/:id` | 删除档位；若被 `policy` 引用则 409 |
| POST | `/api/system/models/:id/test` | 单档探测，语义与 `POST /api/system/llm/test` 一致：`{ ok, stage, code, httpStatus, latencyMs, message, model }` |
| POST | `/api/system/models/route` | body `{ input?: string, projectId?: string }` → `{ tier, profileId, model, score, reasons[], estimatedTokens, estimatedCostUsd }`；只算不写 |

`RoutePolicy` = `"auto" | "economy" | "balanced" | "premium" | "fixed:<profileId>"`
`thresholds` = `{ economyMax: 0.40, balancedMax: 0.75, avgStepTokens: 1200, weights: {...} }`

### 4.2 使用量（登录用户）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/usage?from=&to=&projectId=&groupBy=tier\|profile\|model\|day` | `{ totals: { jobs, tokensInput, tokensOutput, tokensTotal, costUsd }, series: [...] }` |

`GET /api/jobs/:id` 的响应body 扩展：`usedModel`、`usedProfileId`、`tokens: { input, output, total }`、`costUsd`、`routing`。

### 4.3 兼容层

`/api/system/llm` 的 `GET/PUT/DELETE/POST /test` 全部保留，内部映射为「`tier=balanced` 且 `id="baseline"` 的档位」。只配基线时，`auto` 选它。

## 5. 难度打分（rule-based v1）

```
n_modules   = plan.modules.length                      // 归一化 n/16 ，截断到 1
n_fields    = Σ spec.models[*].fields.length           // 归一化 n/40
depth       = composition 依赖链最大深度                // 归一化 n/4
custom_code = 需要 ISOLATION/custom code ? 1 : 0
input_len   = min(len(input)/2000, 1)

score = 0.35·n_modules + 0.25·n_fields + 0.20·depth + 0.10·custom_code + 0.10·input_len
```

分档：`score < economyMax → economy`；`< balancedMax → balanced`；否则 `premium`。
同一 tier 有多个 profile 时取 `enabled=true` 且 `updated_at` 最新的一条。
缺 `plan`（任务尚未规划）时用 `input_len` 单独定档，此时 `reasons` 里写明 `plan-pending`。

**权重与阈值必须可配**，因为后面接 LLM 版打分会替换这段，接口形状不变。

估算公式：
```
estimatedTokens    = round(input_len_chars / 1.6) + LLM_MAX_STEPS · avgStepTokens   // LLM_MAX_STEPS 默认 18
estimatedCostUsd   = estimatedTokens · (priceIn + priceOut) / 2 / 1e6
```
这是粗估，只用于路由预览与前端展示；真实成本以 `jobs.cost_usd` 为准。

## 6. Provider 改造

```ts
export type LlmUsage = { input: number; output: number; total: number };

export interface LlmResult {
  message: LlmMessage;
  usage?: LlmUsage;   // 服务商未返回时为 undefined
  model?: string;
}

export interface LlmProvider {
  complete(messages: LlmMessage[], tools: unknown[], signal?: AbortSignal): Promise<LlmResult>;
}
```

调用侧（`server/agent.ts:702` 附近）每轮累加，任务结束时写库：

```ts
job.tokens_input  += usage?.input  ?? 0;
job.tokens_output += usage?.output ?? 0;
job.cost_usd      += (usage.input * priceIn + usage.output * priceOut) / 1e6;
```

`usage` 缺失时按 0 计并写 `routing.degraded = "no-usage"`，**不得抛错**——服务商兼容性差异很大。

## 7. 错误码

| code | HTTP | 场景 |
| --- | --- | --- |
| `MODEL_PROFILE_NOT_FOUND` | 404 | 按 id 找不到档位 |
| `NO_PROFILE_FOR_TIER` | 409 | 该档位下没有启用的档位配置 |
| `PROFILE_IN_USE` | 409 | 删除被策略引用的档位 |
| `ADMIN_REQUIRED` | 403 | 非管理员调用管理接口（沿用现有 `requireAdmin`） |
| `INVALID_BASE_URL` | 400 | 远程地址非 HTTPS（沿用 `normalizeBaseUrl` 规则） |

## 8. 验收清单（M05–M08 的判定依据）

1. 只配一个档位时，`POST /api/jobs` 行为与改造前一致，`jobs.used_model` 有值。
2. `POST /api/system/models/route` 对同一输入连调 3 次，`tier` 与 `score` 完全一致。
3. 非 admin 调用 `PUT /api/system/models` → 403 `ADMIN_REQUIRED`。
4. 跑完一次真实任务，`GET /api/system/usage` 的 `tokensTotal` 与 DeepSeek 控制台同任务 token 误差 < 2%。
5. `npm test` 与 `npx playwright test` 全绿。
6. 删除被 `fixed:<id>` 引用的档位 → 409 `PROFILE_IN_USE`。

## 9. 变更记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v0.1 | 2026-11-09 | 首版：档位模型、路由策略、打分公式、usage 接口、provider 改造点与验收清单 |
