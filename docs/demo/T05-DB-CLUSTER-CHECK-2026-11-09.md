# T05 数据库集群兼容验证 · 执行记录

- 颗粒：T05 数据库集群兼容验证（P1）
- 执行时间：2026-11-09 17:42–17:45（Asia/Shanghai）
- 执行人：P1
- 结论：**通过（✅）**，原集群可直接沿用，无需重建

## 一、环境事实

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\zhour\Desktop\创赛\atlas-campus-foundry-master\atlas-campus-foundry-master` |
| PGlite 包版本 | `@electric-sql/pglite` 0.5.8 |
| PGlite 内置 PostgreSQL | 18.3（`select current_setting('server_version')`） |
| 现有集群 | `.data/control`，`PG_VERSION = 18` |
| Node | v22.23.2（package.json 要求 ≥24，本次未阻塞） |
| 集群体积 | 39.1 MB / 1065 文件 |

**关键判断**：`.data/control` 的 `PG_VERSION=18` 与 PGlite 0.5.8 内置的 PostgreSQL 18.3 属同一大版本，因此不存在「低版本打不开高版本数据目录」的问题。

## 二、启动前只读探测（未启动服务）

```
server_version: 18.3
public tables: 20
  accounts: 1
  app_secrets: 0
  applications: 0
  audit_log: 0
  community_posts: 0
  community_replies: 0
  creator_products: 0
  creator_profiles: 0
  cross_app_grants: 0
  deployments: 0
  install_history: 0
  job_events: 0
  jobs: 0
  module_installs: 0
  module_versions: 94
  projects: 0
  schema_migrations: 3
  sessions: 1
  team_members: 0
  teams: 0
```

解读：
- 20 张业务表齐全，`module_versions = 94`（与内置 94 个模块一致）→ 元数据完整。
- `schema_migrations = 3` → 迁移版本已是最新，无需补跑。
- `accounts = 1`、`sessions = 1` → 库内有历史账号（来自制作者机器），但 `.data/local-access.json` 不存在，**该账号密码不可知**。
- `projects = 0` → **三套示例此前从未在本数据目录部署过**，与 T02 的检查结论一致。

## 三、启动服务（沿用现有 `.data`）

命令：
```
$env:PORT="3000"; $env:HOST="127.0.0.1"; $env:PUBLIC_ORIGIN="http://127.0.0.1:3000"
node --import tsx server/main.ts
```

服务日志（无任何迁移或版本告警）：
```
{"level":30,"pid":32004,"msg":"Server listening at http://127.0.0.1:3000"}
```

接口验证：
```
GET /api/health  → {"status":"ok","service":"campus-foundry","database":"pglite-postgresql"}
GET /api/system  → 401（未登录，符合预期）
POST /api/auth/register → 201，账号 t05-probe@campus.local / role=developer
GET /api/auth/me → {"user":{"email":"t05-probe@campus.local",...}}
GET /api/system  → {"llm":{"configured":false,"model":null},"deployment":{"provider":"local-trusted","docker":false,"untrustedCode":"docker-required"},"version":"0.1.0"}
GET /api/projects → {"items":[]}
```

## 四、停机后复核（证明无损坏）

```
server_version: 18.3
public tables: 20
  accounts: 2        ← 新增 t05-probe，写入链路正常
  sessions: 2        ← 新增会话
  module_versions: 94
  projects: 0
  schema_migrations: 3
```
端口 3000 已释放，无残留进程。

## 五、备份

启动前已完整备份：`C:\Users\zhour\Desktop\创赛\_demo-backup\data-前置-20261109-1742`（39.1 MB / 1065 文件，robocopy /MIR）。

## 六、遗留与下一步

1. **T02 现已解除阻塞**：数据库可用、`/api/health` 正常，可在本机直接执行 `npm run deploy-local`（会创建 `developer@campus.local` 并把凭据写入 `.data/local-access.json`）。
2. 库内 `t05-probe@campus.local` 为本次验证所用账号（role=developer），保留不影响演示；如需清理需手工删 `accounts` 行。
3. `server_version` 与 `PG_VERSION` 同为大版本 18 —— 若后续更换 PGlite 版本或改用原生 PostgreSQL，需重跑本颗粒。
