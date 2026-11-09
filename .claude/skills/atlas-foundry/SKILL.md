---
name: atlas-foundry
description: 操作 Atlas / Campus AI App Foundry 平台（校园应用低代码工作台）的运维与分析技能。用于启动或停止本地平台、部署示例应用、配置平台级 LLM 端点、提交并跟踪 AI 开发任务（jobs）、读取复用率证据、以及在答辩/演示现场排查故障。当任务涉及该仓库的 server/main.ts、/api/system、deployments、reuse-report、或需要解释平台能力边界时使用。
---

# Atlas Foundry 平台操作技能

未来接入本平台的 AI Agent（运维/演示/研发）按本文件操作，不要凭猜测调用接口。

## 0. 事实基线

- 仓库根：`atlas-campus-foundry-master/atlas-campus-foundry-master`（双层目录）。
- 栈：TypeScript + React 19 + Vite + Fastify 5 + PGlite（内嵌 PostgreSQL 18.x）/ 可选外部 PostgreSQL。
- 单进程平台，默认 `HOST=127.0.0.1 PORT=3000`，入口 `/`，控制台前端 `/studio`。
- 数据目录 `DATA_DIR=.data`：`control/` 为控制库（PGlite 集群）、`apps/` 为每个已部署应用独立数据库、`artifacts/` 存产物与复用报告。
- **PGlite 单实例锁**：同一 `DATA_DIR` 同时只能有一个进程打开控制库。要直接读写数据库，必须先停服务。
- 语言：平台 UI 中英双语（685 个 key）；代码与日志保持英文。

## 1. 启动 / 停止

```powershell
# 启动（前台；演示时用后台窗口）
cd <repo>
node --import tsx server/main.ts          # 读 .env
# 或
npm run dev                                # build + start-local（自动挑空闲端口，写 .data/local-running.json）
```

停止：结束该 node 进程即可（`Ctrl+C` / 关闭窗口）。停止后部署的应用子进程随之退出，但数据库里仍记为 `running`，下次启动需 `POST /api/deployments/:id/restart` 或重跑 `npm run deploy-local`。

健康检查：`GET /api/health` → `{"status":"ok","service":"campus-foundry","database":"pglite-postgresql"}`。只要这一条不通，先查进程与端口，不要动数据目录。

## 2. 认证

所有 `/api/*`（除 `/api/health`）都要会话 Cookie。

```powershell
$c = Get-Content .data\local-access.json -Raw | ConvertFrom-Json
Invoke-RestMethod http://127.0.0.1:3000/api/auth/login -Method Post `
  -Body (@{email=$c.email;password=$c.password}|ConvertTo-Json) `
  -ContentType application/json -SessionVariable s
```

- 演示账号在 `.data/local-access.json`（`developer@campus.local`，随机口令，name 校园产品开发者）。
- 角色：`admin` / `developer` / `member`。**第一个注册的账号自动成为 admin**；自建模块审核（`/api/modules/:id/approve`）与平台配置接口都要求 admin。
- 注册端点 `POST /api/auth/register`（`ALLOW_REGISTRATION=true` 时开放）。新注册一律是 `developer`。

## 3. 平台级模型端点（后端口径，无自选 provider）

平台只认一个 OpenAI 兼容端点，由运维在**后端**配置，不提供按用户自选 API 的界面。

优先级：`platform_settings` 表里的记录 > `.env` 的 `LLM_*`。写入立即对 `process.env` 生效，**不需要重启**——`Agent.startJob` 与 `OpenAICompatibleProvider.complete` 每次调用都读环境变量。

```powershell
# 查看（任何登录用户）
GET    /api/system/llm
# 写入 / 覆盖（仅 admin）
PUT    /api/system/llm    {"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-..."}
# 连通性探测（仅 admin）：返回 ok / stage / code / latencyMs，不泄露 key
POST   /api/system/llm/test   {}
# 清除（仅 admin）：回落到 .env 的值
DELETE /api/system/llm
```

响应形状：`{configured, model, baseUrl, apiKeyPresent, source}`，`source` 为 `platform-settings` 或 `environment`。

- key 以 AES-256-GCM 加密存 `platform_settings.value`，密钥文件 `.data/vault.key`（0600）。任何接口都不回显 key。
- 远程端点强制 HTTPS；`127.0.0.1`/`localhost`/`::1` 可用 http。
- 探测失败的 `code` 语义：`LLM_UNCONFIGURED` 未配置、`HTTP_401/403` 凭据被拒、`HTTP_404` 地址或模型名不对、`HTTP_429` 限流或额度不足、`LLM_UNREACHABLE` 域名不可达、`LLM_TIMEOUT` 超时。
- 未配置时 `POST /api/jobs` 仍会建任务，但 `status='blocked'`、`error='LLM_UNCONFIGURED'`——这是设计行为，不是故障。

## 4. AI 开发任务（jobs）

```powershell
POST /api/jobs        {"input":"<需求文本 5-12000 字>","mode":"llm"}   # 或 "design"（不调用模型，只出设计）
GET  /api/jobs/:id    # status: queued|running|blocked|succeeded|failed|cancelled，附 plan/result/error
GET  /api/jobs        # 自己的任务列表
POST /api/jobs/:id/cancel | /retry
```

- 单账号并发上限 3 个 `queued|running` 任务，超出返回 429 `JOB_QUOTA`。
- `mode="design"` 走确定性规划，可在**没有任何模型 key** 的情况下演示全流程，适合网络不确定的答辩现场。
- 任务过程事件：`job_events`（`requested` / `module_references` / step 事件等）。

## 5. 应用与部署

```powershell
GET  /api/projects                       # 项目列表
GET  /api/projects/:id/modules           # 已安装模块
POST /api/projects/:id/extract           # 抽出自建模块（待审核）
POST /api/modules/:id/approve            # 仅 admin
POST /api/projects/:id/deploy            # 生成应用 + 起独立进程与独立数据库
GET  /api/deployments                    # 含 status / port / app_id
POST /api/deployments/:id/{stop|restart|rollback}
GET  /api/deployments/:id/logs | /health
```

- 每个应用 = 独立进程 + 独立数据库（`.data/apps/<appId>`）+ 独立账号会话，端口自动分配、不固定。
- 应用对外地址形如 `http://app-<app_id>.localhost:<port>`。
- 应用数据读写端点是 **`/api/entities`**（模块组合路由由 `server/runtime-server.ts` 生成），不是 `/api/records/*`。
- 一键起演示：
```powershell
npm run deploy-local      # Campus Events / Campus Marketplace / Study Buddy → .data/showcase.json
npm run deploy-visual     # 纯声明式编排（无模型推理）→ .data/visual-showcase.json
npm run deploy-commerce   # 商业社区（18 模块，线下结算）→ .data/commercial-showcase.json
```
- 三个脚本幂等：按项目名复用已有项目，重复跑不会造重复数据。

## 6. 复用率证据（答辩数字口径）

```powershell
npm run reuse-report -- --showcase
```
产物 `artifacts/showcase-reuse-report.json`：`uniqueApplications` / `moduleInstallationCount` / `distinctModuleIds` / `sharedCodeImplementations` / `sharedRuntimeLines` / `applicationSpecificExecutableLines`。退出码 0 才算通过；`<3` 个应用或有 `sameCurrentSource=false` 会返回 1。

**对外只能引用这份文件里的数字**，不要手工推算百分比。

## 7. 已知坑

1. `npm run deploy-local` 若报 `需要平台管理员审核`：当前登录账号不是 admin。库中若已存在更早的管理员账号，新账号拿不到 admin，需把演示账号提为 admin（改库前先停服务并备份）。
2. `api.openai.com:443` 在国内常见出口不可达；`api.deepseek.com` / `dashscope.aliyuncs.com` / `api.moonshot.cn` / `open.bigmodel.cn` / `api.siliconflow.cn` / `ark.cn-beijing.volces.com` 可达。演示前用 `POST /api/system/llm/test` 实测，不要假设。
3. 同时只能有一个进程打开 `.data`；报「存储被占用」类错误时先查残留 node 进程。
4. `engines.node >=24`，本机实测 Node 22 也能跑通构建与测试；不要因为版本号顺手升级运行时。
5. Windows PowerShell 5.1：不支持 `python - <<'PY'` 的 heredoc；`.env`/脚本写中文请用 UTF-8（带 BOM 的 .ps1 才能被正确读取）；控制台 GBK 下跑含 emoji 的 Python 需 `$env:PYTHONIOENCODING="utf-8"`。
6. `.data`、`node_modules`、`dist`、`artifacts`、`.env` 全在 `.gitignore` 内，不要试图提交。

## 8. 变更前先做

- 动数据库：`robocopy .data <备份目录> /MIR`，改完核对 `schema_migrations` 与关键表行数。
- 改服务端：`npx tsc --noEmit` → 起服务打 `/api/health` → 跑目标接口 → 再提交。
- 改文档口径：同步 `docs/demo/TECH-PROGRESS.md` 与 `.csv`，别只改一份。
