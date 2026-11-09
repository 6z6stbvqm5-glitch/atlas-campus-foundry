# 工作台应用启停控制（Runtime Start / Stop）

- 文档编号：ATLAS-DEMO-FEATURE-001
- 版本：v1.0
- 日期：2026-11-09
- 状态：已实现、已实测

## 1. 背景与问题

工作台原有的部署页（`web/studio.tsx` 的 `/deployments`）只有「重新部署 / 停止 / 回滚 / 日志 / 健康检查 / 删除」：

- **没有「启动」**：应用一旦 stop，只能靠「重新部署」（`server/deployment.ts:652 async restart`）找回，而 restart 的实现是「停掉旧的 + `deploy()` 新的一条部署记录」。
- 后果对答辩现场是致命的：**端口会变、部署记录会多一条、应用地址会换**，之前印在讲稿/PPT/截图里的链接全部失效。

因此需要一种「原地启动」：同一个 deployment、同一个端口、同一条记录。

## 2. 实现

### 2.1 健康探针（新增）

`server/deployment.ts:515`

```ts
private async probe(appId: string, port: number) {
  // fetch http://127.0.0.1:${port}/api/health, AbortSignal.timeout(1000)
  // 返回 response.ok && body.appId === appId
}
```

探针必须校验返回体重 `appId` 与部署记录一致：端口可能被上一个残留进程占着，只有 appId 对上才算「这个应用活着」。

### 2.2 原地启动 `start()`

`server/deployment.ts:527 async start(id, actor)`

| 前置状态 | 行为 |
| --- | --- |
| `running` 且 `probe()` 通过 | 直接返回该行（幂等，不重启、不换端口） |
| `running` 但 `probe()` 失败 | 视为**进程已死**，继续走启动流程（关键修正，见 §4） |
| `deleted` | 409 `DEPLOYMENT_DELETED` |
| 无 artifact / 缺 `artifact.json` | 409 `ARTIFACT_MISSING` |

启动流程：

1. 读 `artifact.json`，重写 `runtime.json`（docker → `/app-data`；local-trusted → `path.resolve(projects.root, "apps", row.app_id)`）。
2. 状态置 `starting`。
3. local-trusted：`spawn(process.execPath, ["--import","tsx","server/runtime-main.ts"], { env: { RUNTIME_CONFIG, RUNTIME_PORT, RUNTIME_HOST: "127.0.0.1", DOTENV_CONFIG_PATH }, cwd, stdio: ["ignore","pipe","pipe","ipc"], windowsHide: true })`，日志 append `runtime.log`。
4. docker：`docker start foundry-${id}`。
5. 健康轮询 `45 × 300ms`，成功 → `running` + 日志 `Started on port ${row.port} (in-place). HTTP health check passed.` + 审计事件 `deployment.started`；超时 → `terminate()` + `failed`。

**不新增部署行，不改 port。**

### 2.3 路由

`server/control.ts:418`

```ts
app.post("/api/deployments/:id/start", async (request) =>
  deployments.start(id(request), requireUser(request).id));
```

### 2.4 前端

- `web/studio.tsx:1313 function AppRuntimePanel()`：Dashboard 上的运行控制面板
  - `useLoad<{items: Deployment[]}>("/api/deployments", 4000)`，过滤 `status !== "deleted"`
  - 标题「应用运行控制」+「运行中 N / 总数」
  - 「全部启动」「全部停止」：逐个 POST，失败项汇总成一条消息（不中断）
  - 每行：Badge + 端口 +「打开应用」+（running 时「重启」否则「启动」）+ running 时「停止」
- `web/studio.tsx:342`：面板挂到 Dashboard metrics 之后
- `web/studio.tsx:1444 function DeploymentView`：行内新增「启动」按钮
- `web/locales/en.json`：新增 9 键（762 → 771）。仓库中文即源键，无 zh.json，中文直接渲染

## 3. 验证证据（均为真实 HTTP 调用）

### 3.1 幂等 / 停止 / 重启（Campus Events，deployment `50b28258-71a9-49be-830b-be1d404f7c1f`，端口 59993）

| 步骤 | 结果 |
| --- | --- |
| `POST /api/deployments/50b28258.../start` | `running`、`port=59993`、`pid=8420`、`1776ms`；health `UP appId=ca8a5fa6-1151-4281-bb4f-f5cbb8017cfb` |
| 重复 `start` | `running`、`pid=8420`、`26ms`（**未重启、未换端口**） |
| `POST .../stop` | `{"ok":true}`；health `DEAD` |
| 再次 `start` | `running`、`port=59993`、`pid=29392`、`1675ms`；health `UP` |
| 部署记录数 | 7 → 7（**未新增行**） |

### 3.2 全量拉起

`_work/start-all.ps1` 结果 5/5 `running / UP`：

| 部署 | 端口 | 应用 |
| --- | --- | --- |
| `30a99717` | 58402 | 商业社区 |
| `de944826` | 56469 | 视觉编排 |
| `b6503b37` | 60013 | Study Buddy |
| `2d601ba5` | 60004 | Campus Marketplace |
| `50b28258` | 59993 | Campus Events |

## 4. 一处必须记住的坑

原实现的第一行是「`status === "running"` 就 return」。但 `status` 是数据库里的记录，不是进程真相：控制服务被强制结束、或 runtime 子进程自己崩掉之后，库里仍然是 `running`，此时「启动」会变成一句「已运行」然后把现场干在那儿。

修法即 `server/deployment.ts:527` 的复合条件：**状态 running 且探针通过**才算已运行。

## 5. 已知限制

- `start()` 依赖 artifact 目录完整。artifact 被清理（`DELETE /api/deployments/:id` 之外的误删）时返回 409 `ARTIFACT_MISSING`，只能重新部署。
- 同一 `app_id` 上如果存在两条非 deleted 的部署记录（历史遗留重复部署），第二条启动会因 PGlite 存储锁报 `Storage is open in another process; stop it before continuing`（`server/storage-lock.ts:48`，code `ELOCKED`）。这是设计上的互斥保护，处理方式是删掉多余的那条记录。
- 「全部启动」是串行 POST，5 个应用约 8–10 秒；答辩时建议提前拉起，不要在现场等。

## 6. 演示口径

讲这一页时可以说：应用生命周期在平台内是**可逆**的——停掉不丢数据、不丢地址、不额外占端口，一点就回来；这一点和「重新部署」是两件事，重新部署才会产生新版本、新地址。
