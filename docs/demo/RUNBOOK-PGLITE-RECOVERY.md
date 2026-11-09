# Runbook：PGlite 数据目录损坏的识别与恢复

- 文档编号：ATLAS-DEMO-OPS-001
- 版本：v1.0
- 日期：2026-11-09
- 适用：答辩机 / 演示环境（`DEPLOYMENT_PROVIDER=local-trusted`，PGlite 0.5.8 内置 PostgreSQL 18.3）

## 1. 先记住这条

**停服务不要强杀进程。**

PGlite 是把 PostgreSQL 编译成 wasm 跑在 Node 里的，它的 WAL 需要一个干净的关闭点。`Stop-Process -Force` / `job_kill` 走的是 `TerminateProcess`，进程不会执行 `SIGINT`/`SIGTERM` 处理函数，WAL 尾部被截断，下次启动直接炸。

服务端其实已经注册了优雅退出：`server/main.ts:18-21` 监听 `SIGINT` / `SIGTERM` → `app.close()`（内部会 `deployments.close()` 停掉 runtime 子进程、`db.close()` 关库）。

推荐的三种停法：

1. `npm run dev` 启动的那个窗口里按 **Ctrl+C**；
2. 用 `scripts/start-local.ts` 起的进程，让父进程正常退出（子进程收到 IPC `disconnect` 会自己关库）；
3. 实在只能杀，先确认已经 `stop` 掉所有运行时子进程，再杀掉主进程，并接受「可能损坏、按 §4 恢复」的代价。

## 2. 症状

- 启动即退出，`_work/server-err.log` 里是：
  ```
  RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
      at ... @electric-sql/pglite/dist/index.js:1:78230
  ```
- 前端打不开，`/api/health` 连不上。
- 打开 `debug: 5` 后能看到真实原因（PostgreSQL 自己的日志）：
  ```
  LOG: invalid record length at 0/1BD99F0: expected at least 24, got 5
  LOG: invalid checkpoint record
  PANIC: could not locate a valid checkpoint record at 0/1BD99F0
  ```

看到 `could not locate a valid checkpoint record` 就是 WAL 损坏，不是端口/配置问题。

## 3. 判断范围

损坏通常是**三处一起**：控制库 + 每个应用自己的库。

- 控制库：`.data/control`
- 应用库：`.data/apps/<app_id>`（每个已部署应用一个 PGlite 集群）

只修控制库，应用起来后仍会各自崩在同一条 PANIC 上。

## 4. 恢复步骤

### 4.1 只读验证备份是否健康

用 `_work/pgprobe.mjs` 这类只读探针（`PGlite.create({ dataDir })` + `select current_setting('server_version')` + 关键表计数）：

```js
const { PGlite } = await import("@electric-sql/pglite");
const db = await PGlite.create({ dataDir: process.argv[2] });
console.log(await db.query("select current_setting('server_version') as v"));
console.log(await db.query("select count(*)::int as n from deployments"));
await db.close();   // 必须 close，否则留下 postmaster.pid
```

### 4.2 换掉损坏目录（保留取证）

```powershell
Move-Item .data\control .data\control-corrupt-<日期时间>
robocopy <备份根>\control .data\control /MIR
Remove-Item .data\control\postmaster.pid -ErrorAction SilentlyContinue
```

应用库同理：

```powershell
robocopy <备份根>\apps\<app_id> .data\apps\<app_id> /MIR
```

**注意**：应用库里的数据是「示例记录」，恢复到备份点等于丢掉备份之后新增的记录。答辩演示前做这一步没有代价；答辩中途做，等于回滚演示数据。

### 4.3 重启并复核

```powershell
node --import tsx server/main.ts      # 或 npm run dev
```

复核清单：

- 日志只有 `Server listening at http://127.0.0.1:3000`，没有迁移告警、没有 PANIC；
- `GET /api/health` → `{"status":"ok","service":"campus-foundry","database":"pglite-postgresql"}`；
- `GET /api/deployments` 里 `deleted` 之外的记录数与备份点一致；
- 逐个 `POST /api/deployments/:id/start`，全部 `running` 且 `/api/health` 返回对应 `appId`。

## 5. 本次（2026-11-09）实际记录

| 项 | 值 |
| --- | --- |
| 触发动作 | 用 `Stop-Process -Force` / `job_kill` 反复强杀 `server/main.ts` 以重载新代码 |
| 损坏对象 | `.data/control`、`.data/apps/2ca01646-fe71-46e0-aef9-abe49ee3350d`（58402 商业社区）、`.data/apps/e7f806bc-372f-48fb-a2dc-e2a7355036b9`（56469 视觉编排） |
| 取证副本 | `.data/control-corrupt-20261109-2056`、`apps/*-corrupt-20261109` |
| 恢复来源 | `_demo-backup/data-接入前-20261109-1915`（探针验证：PG 18.3、deployments=7） |
| 结果 | 控制服务正常启动，5 个应用全部 `running / UP`，端口保持 58402 / 56469 / 60013 / 60004 / 59993 |
| 事故前快照 | `_demo-backup/control-20261109-2118`（1068 文件） |

## 6. 备份清单（本机）

| 目录 | 时间 | 覆盖 |
| --- | --- | --- |
| `_demo-backup/data-前置-20261109-1742` | 2026-11-09 17:42 | T05 前的完整 `.data`（1065 文件 / 39.1 MB） |
| `_demo-backup/data-接入前-20261109-1915` | 2026-11-09 19:15 | T06 接入前的完整 `.data`（6881 文件） |
| `_demo-backup/control-20261109-2118` | 2026-11-09 21:18 | 事故恢复后的控制库快照（1068 文件） |

**答辩前一天务必再做一份**「完成态」快照，并在彩排机上演练一次恢复（对应任务表 T04）。

## 7. 一句话总结

WAL 损坏听着吓人，其实是「快照 + 覆盖 + 重启」三步的事；真正要防的是**下次还用强杀**。
