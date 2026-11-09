# T06 模型接入验证记录（2026-11-09）

文档编号：ATLAS-DEMO-T06-20261109
执行：P1 技术负责人
结论：**✅ 通过（平台级模型通道可用，Agent 全链路真实跑通）**

## 1. 目标与口径

T06 的验收不看"接口能存 key"，而看三件事：

1. 后台写入端点后，探测能返回 `ok`；
2. `npm run verify-integrations` 的 LLM 环节能真实发起一次带 `tool_calls` 的补全；
3. 真实 Agent 任务能从自然语言需求走到"模块组装 + 本地部署"，并产出可读写的应用。

`verify-integrations` 退出码 2 表示"外部资源受阻"（本机无 Docker、无原生 PostgreSQL、无 SMTP），不是失败。

## 2. 密钥与端点

| 项 | 值 |
| --- | --- |
| 端点 | `https://api.deepseek.com/v1` |
| 模型 | `deepseek-chat`（`/v1/models` 只列 `deepseek-flash`、`deepseek-v4-pro`，`deepseek-chat` 是稳定别名） |
| 工具调用 | 支持（实测返回结构化 `tool_calls`） |
| 网络 | `api.openai.com:443` 不可达；`api.deepseek.com`、`dashscope.aliyuncs.com`、`api.moonshot.cn`、`open.bigmodel.cn`、`api.siliconflow.cn`、`ark.cn-beijing.volces.com` 可达 |
| 落地位置 | `.env` 三件套（`LLM_BASE_URL`／`LLM_MODEL`／`LLM_API_KEY`）或后端接口写入 `platform_settings`（密文） |

密钥不写入仓库：`.env` 与 `.data` 均在 `.gitignore` 内。

## 3. 四个接入接口实测

| 接口 | 权限 | 实测返回 |
| --- | --- | --- |
| `GET /api/system/llm` | 登录用户 | `{"configured":true,"model":"deepseek-chat","baseUrl":"https://api.deepseek.com/v1","apiKeyPresent":true,"source":"platform-settings"}` |
| `PUT /api/system/llm` | 平台管理员 | 写入后 `process.env` 即时生效，无需重启 |
| `POST /api/system/llm/test` | 平台管理员 | `{"ok":true,"stage":"done","code":"OK","latencyMs":122-265,"usage":{...}}` |
| `DELETE /api/system/llm` | 平台管理员 | 删除行并回落 `.env` 基线，`source` 变回 `environment` |

异常路径也已验证：假域名 → `LLM_UNREACHABLE`；假密钥 → `HTTP_401`；非管理员调用 → `403 ADMIN_REQUIRED`；`api.openai.com` → 超时。四类错误可区分，演示时不会出现"永远转圈"。

## 4. verify-integrations

```
TESTED: LLM live tool call
BLOCKED: Docker runtime (未安装 Docker/WSL)
BLOCKED: Native PostgreSQL
BLOCKED: SMTP
退出码 2（外部资源受阻）
```

LLM 环节走的是真实网络请求：`OpenAICompatibleProvider().complete` 断言模型必须回 `verify_connection` 工具调用，返回即计通过。

## 5. 真实 Agent 任务（关键证据）

- 任务：`为校园社团做一个活动报名应用：需要活动列表、在线报名、结果通知、关键词搜索，包含社团主页与成员管理，不要自定义代码，全部用平台已有模块组装，不需要指定画布连线。`
- job：`29f772e5-488c-4f51-be05-6c6aed43a098`，状态 `succeeded`，16 步，约 50 秒。
- 落库项目：`d10b5f33-dc59-445e-a899-d52783a4a98f`。
- 组装模块（12 个）：`identity, campus, content, profiles, chat, groups, notifications, events, creator-profiles, member-directory, search, keyword-search`。
- 规格：3 个角色、7 个数据模型、8 条验收场景、6 个画布节点（模型未画依赖边，平台按模块依赖自动补齐）。
- 预览：部署 `b1823f29-7923-4534-a774-8df9522b2947`，`app_id=8bda1dee-b47b-445f-b2f3-004e36f30661`，端口 `63313`，`provider=local-trusted`，日志 `HTTP health check passed. Database is reachable.`
- `GET /api/health` → `{"status":"ok","appId":"8bda1dee-...","storage":"postgresql","runtime":"shared-modules"}`

### 预览应用功能验证（真实 HTTP）

```
POST /api/auth/login            → 登录成功（member）
POST /api/entities {kind:event} → 201，活动「AI 社团宣讲会」，容量 120，地点「图书馆报告厅」
POST /api/entities {kind:group} → 201，社团「AI 社团」
GET  /api/entities?kind=event   → 1 条，中文与 data 字段完整
GET  /api/entities?q=AI         → 命中活动与社团（关键词搜索生效）
GET  /api/notifications         → {"items":[]}（尚无通知，符合新库状态）
GET  /api/application           → 12 个模块清单与规格一致
```

## 6. 排障过程中修复的 5 处平台缺陷（`server/agent.ts`）

演示能否稳定，取决于模型被拒绝时平台是否兜底。以下修复都已合入：

1. **工具顺序约束**：模型先调 `selectModules` 会拿 `PROJECT_REQUIRED`，连续 3 次即报废。提示词写入强制序列 `searchModules → createApplication → selectModules → …`，`project()` 错误文案改为可执行的下一步指令。
2. **画布依赖方向**：`packages/modules/src/composition.ts:29-36` 约定 `source=提供方、target=使用方`，模型全写反导致"尚未连接依赖"。新增 `autoComposition()`，模型省略画布时平台按模块依赖自动生成合法边。
3. **规格清洗**：`models[*].fields[*].references` 指向未声明的模型会让 zod 直接拒单。新增 `sanitizeSpec()`：按 id 去重、非法引用降级为 `text`、非引用字段清 `references`、非法 `roleId` 回落首个角色。
4. **目录读取**：`readProjectFiles {path:"."}` 报 `UNSAFE_PATH`、`{path:"src"}` 报 `EISDIR`。改为归一化路径＋目录返回文件列表。
5. **环境阻塞不计失败**：`runBuild`／`runTests` 在无 Docker 时返回 `ISOLATION_UNAVAILABLE`，原本计入修复预算。改为视为环境阻塞（不重试、直接交付预览），并把"累计失败"改成"连续失败"，一次成功即清零。

## 7. 已知缺口（属既定 BLOCKED 项，不影响 T06 判定）

- 无 Docker → `runBuild`／`runTests` 无法执行，job 结果 `buildPassed=false, testsPassed=false`。模型在最终答复中如实说明，未谎称通过。
- `npm run verify-live-agent` 硬门控 Docker + `ENABLE_CUSTOM_CODE=true` + HTTPS/`PUBLIC_ORIGIN` + `APP_DOMAIN`，本机必然 `BLOCKED`；本记录即其替代验证路径。
- 预览仅 `local-trusted`，`http://127.0.0.1:<port>`，不做公网部署。

## 8. 复现步骤

```powershell
cd "C:\Users\zhour\Desktop\创赛\atlas-campus-foundry-master\atlas-campus-foundry-master"
# 1) 写 .env：LLM_BASE_URL / LLM_MODEL / LLM_API_KEY
# 2) 起服务
Start-Process node -ArgumentList "--import","tsx","server/main.ts" -WorkingDirectory $PWD -WindowStyle Hidden
# 3) 跑全链路（登录 → 写 key → 探测 → 建 job → 轮询）
powershell -ExecutionPolicy Bypass -File "C:\Users\zhour\Desktop\创赛\_work\verify-llm-flow.ps1"
# 4) 验证预览应用
powershell -ExecutionPolicy Bypass -File "C:\Users\zhour\Desktop\创赛\_work\probe-preview-app.ps1"
```

脚本说明：`_work\verify-llm-flow.ps1` 含明文密钥，只在本机工作区使用，不入库；`.ps1` 必须存成 **UTF-8 BOM**，否则 Windows PowerShell 5.1 按 ANSI 读中文路径会乱码。

## 9. 遗留清理

- `_work\server-out.log`／`server-err.log` 为本次启动日志，可随时删除。
- 预览应用内的测试账号 `llm-demo@campus.local` 与两条示例记录位于 `.data` 运行时库，不进控制库。
