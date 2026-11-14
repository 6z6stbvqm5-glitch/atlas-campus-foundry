# 模拟实验：代码块 × Agent 开发成功率与成本

回答一个问题：把「能力模块（代码块）」交给 agent 之后，它在**难度递增**的需求上还能做出来多少、每次成功要花多少钱，以及相对一个只有通用能力、没有块库的基线，差距有多大。

实验全部是**可复现的蒙特卡洛测算**，不是拍脑袋的示意图：任务集来自仓库里真实的模块目录 `packages/modules/src/catalog.ts`（94 个块、依赖闭包、配置字段都从代码里算），token 量级用真实 DeepSeek 接口校准过一次，其余参数在报告里逐条列出。

## 目录

| 路径 | 内容 |
| --- | --- |
| `代码/sim.ts` | 主实验：5 档难度 × 3 种方法 × 每格 5000 次抽样 |
| `代码/scaling.ts` | 放大实验：难度整体 ×2/×3/×4/×6，两种步数预算（18 / 40） |
| `代码/calibrate.ts` | 真实接口校准：读 `.env` 里的 DeepSeek key，实测 agent 一轮的 prompt token |
| `代码/gen-report.mjs` | 把三份 JSON 合成 `报告/report.md` |
| `代码/figures.mjs` | 海报 + 难度曲线（`poster-comparison`、`difficulty-curve`） |
| `代码/figures-scaling.mjs` | 放大实验 2×2 面板 |
| `代码/poster-baseline.mjs` | 最终海报（General AI 作为难度基准的那一版） |
| `数据/simulation-results.json` | 主实验全量输出（逐档统计 + 18 次逐条尝试） |
| `数据/scaling-results.json` | 放大实验全量输出 |
| `数据/calibration.json` | 真实接口校准结果 |
| `图表/*.png` `图表/*.svg` | 四张图（SVG 可直接改字） |
| `报告/report.md` | 完整数据报告（Word 的源文件） |
| `报告/blocks-experiment.md` | 主实验的简版读数 |
| `报告/scaling-experiment.md` | 放大实验的简版读数 |
| `报告/ATLAS代码块开发效率模拟实验报告.docx` | **最终交付物**：16 张表 + 3 张图 |
| `报告/ref.docx` | pandoc 转 Word 用的样式模板（A4、宋体、表格描边） |

## 结论

| 方法 | 18 次里成功 | 成功率 | 每成功成本 | 成本指数 |
| --- | --- | --- | --- | --- |
| General AI（基线） | 7 | 39% | $0.036 | 3.54× |
| AI + Capability Modules | 10 | 56% | $0.022 | 2.20× |
| ATLAS | 15 | 83% | $0.010 | 1.00× |

- 难度每升一档，通用基线的成功率掉得最凶（L5 只剩 6%），ATLAS 还能守住 65%。
- **最难那一档（L5，含自定义代码）差距最大**：通用基线每次成功 $0.2512，ATLAS $0.0174，差 **14.4 倍**。
- 差距的机制是**步数预算**：ATLAS 一次 `selectModules` 就把块和依赖闭包一起落下，稳定停在 12~15 步；通用基线在 L4/L5 会撞上 18 步上限。
- 难度同比放大后差距继续拉大：×6 规模、18 步预算下，基线已经开不出成功样本，ATLAS 还有 3%。把 `stepPerModule` 从 1.2 降到 0.35（批量提交假设）后，×6 规模 ATLAS 能回到 15%。

## 复现

在仓库根目录（`atlas-campus-foundry-master/atlas-campus-foundry-master`）执行：

```bash
npx tsx 模拟实验/代码/sim.ts            # → 数据/simulation-results.json、报告/blocks-experiment.md
npx tsx 模拟实验/代码/scaling.ts        # → 数据/scaling-results.json、报告/scaling-experiment.md
npx tsx 模拟实验/代码/calibrate.ts      # → 数据/calibration.json（需要 .env 里的 LLM_API_KEY）
node 模拟实验/代码/gen-report.mjs       # → 报告/report.md
node 模拟实验/代码/figures.mjs          # → 图表/poster-comparison.png、difficulty-curve.png
node 模拟实验/代码/figures-scaling.mjs  # → 图表/scaling-curve.png
node 模拟实验/代码/poster-baseline.mjs  # → 图表/poster-baseline.png
pandoc 报告/report.md -o 报告/报告.docx --reference-doc=报告/ref.docx --resource-path=报告
```

脚本里的路径全部按**脚本自身位置**解析（`import.meta.url`），所以在哪个目录调用都不影响输出落点。

依赖：Node 18+、`tsx`、`sharp`（项目已有）、pandoc（本机在 `C:\Users\zhour\anaconda3\Library\bin\pandoc.exe`）。没有 `tsx` 时用 `npx tsx` 会自动装。

## 口径与假设

- **难度档**：L1 单块 → L2 双块 → L3 三块+视图+搜索 → L4 多块编排（触发器+条件+通知）→ L5 含自定义代码。复杂度读数 `W = 0.5·块数 + 0.3·连线数 + 0.12·配置字段 + 1.1·文件数 + (自定义码?2:0)`。
- **成功率**：`sigmoid(α − β·level − 0.22·超出步数 − 自定义码惩罚)`，α/β 三方法分别标定；α 的绝对值被校准结果拉高过一轮（system prompt 实测 1848~1858 token）。
- **成本**：$0.28/M 输入、$0.42/M 输出，输出占比按 15% 折算成 3.010e-7 USD/token；`$/成功` 是**含失败重试摊薄**的期望成本（一个难度档的总花费 ÷ 该档成功次数），所以 L5 的数字会显著高于「一次成功路径」的成本。
- **海报第一行为什么单调、后两行为什么允许断点**：第一行是难度尺本体，成功的 attempt 必须排在左端；后两行的缺口代表「更简单的需求恰好缺块而失败，更难的需求反而被块编排兜住了」，这是块库覆盖盲区的可视化，详见报告 5.1 节。
- 这是**模型测算**，不是真跑 54 次 agent。要硬结论，可以按 `数据/simulation-results.json` 里的 18 次任务清单去做真实跑批。
