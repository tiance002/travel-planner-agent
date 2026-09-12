# LangGraph 重写 · 版本记录

本文档记录「用 LangGraph 并行重写行程生成编排」的每一个版本：做了什么、怎么验证、提交到哪个 commit。

## 背景与策略

原项目 `apps/server/src/services/agent/index.ts` 用手写 `while` 循环做编排（按天循环 + 工具循环）。重写目标：

1. **统一技术栈**：后端已是 Node/TypeScript，引入 JS 版 `@langchain/langgraph`，而非 Python 版。
2. **体现 LangGraph 优势**：checkpointer 断点续跑、interrupt 人机协作、并行择优、条件边回退。
3. **不破坏已验证的业务规则**：`scheduler.ts`（校验）、`spot-rules.ts`（规则）、`tools.ts`（高德工具）、`prompt.ts`（提示词）、`model-client.ts`（模型客户端）、`alternatives.ts`（换点）**全部原样复用**，只重写编排外壳。

## 关键设计决策

- **图状态只放可序列化的轻量字段**（进度、去重清单、传导状态）。POI 登记表 registry、天气、凭证这些不可序列化/体积大的对象，放在 `AgentGraphContext` 里，通过 `buildAgentGraph(ctx)` 闭包捕获，每个生成会话 build 一次图，天然并发隔离。
- **状态字段两类写法**：标量用 zod schema（覆盖式），需要累积的用 `ReducedValue`（reducer 合并）。
- **两版并存**：环境变量 `USE_LANGGRAPH=1` 走图版，否则走手写版。稳定后再默认切图版、删旧版。

## 依赖

- `@langchain/langgraph@1.4.15`（`--save-exact` 钉死，JS 版，非 Python 版）
- `@langchain/core@1.2.11`

> 注意：JS 版 LangGraph 的 API 与 Python 版差异很大。1.4.x 用 `new StateSchema({...})` + `ReducedValue`，不是旧版的 `Annotation.Root()`。

---

## V1 —— LangGraph 线性骨架复刻

**目标**：用 StateGraph 把现有「锚点 → 按天循环 → 收尾」流程原样复刻，复用全部纯函数，证明图结构能承载现有业务。

**图结构**：

```
START → resolveAnchor → planDay ──条件边──┐
                          ↑               │
                          └── 还有下一天 ──┘
                          └── 排完 → finalize → END
```

**新增文件**：
- `apps/server/src/services/agent/graph-state.ts` —— 图状态定义（StateSchema + ReducedValue）
- `apps/server/src/services/agent/graph.ts` —— 图结构（三个节点 + 条件边）
- `apps/server/src/services/agent/graph-run.ts` —— 对外入口（装上下文 + 驱动图）
- `apps/server/scripts/check-graph.ts` —— 图单元自检（8 条断言，不调真实模型/高德）

**验证**：
- `npx tsc --noEmit` 通过
- `npm run check:graph` 8/8 通过（图拓扑、checkpointer、interrupt、并发隔离）
- 端到端：`USE_LANGGRAPH=1` 真实生成行程成功

**提交**：（见 git log）

---

## V2 —— Checkpointer 节点级断点续跑

**目标**：把断点续跑从「天级落库」升级到「节点级快照」，进程崩溃重启后能从图中断的节点恢复。

**实现**：
- 引入 `@langchain/langgraph-checkpoint-sqlite@1.0.4`，`SqliteSaver.fromConnString()` 指向 `.debug/langgraph-checkpoints.sqlite`（已被 gitignore）。
- checkpointer 做成**模块级惰性单例**（`getCheckpointer()`），避免每次生成 `fromConnString` 打开新连接导致文件句柄泄漏、WAL 争用。
- `buildAgentGraph(ctx, checkpointer)` 接受可选 checkpointer，`compile({ checkpointer })`。

**与手写版的本质区别**：
- 手写版：进程崩溃 → 只能靠 Prisma「天级」恢复，当天排到一半的进度（已搜的景点、已算的通勤）全丢。
- 图版：进程崩溃 → SQLite 里存着「排到第 N 天、图状态是什么」的快照，重启后用同一 thread_id 从断点继续。

**验证**：
- `npm run check:graph` 扩到 10/10（新增「SQLite 跨实例持久化恢复」2 条断言）。
- 端到端：`USE_LANGGRAPH=1` 真实生成成功，checkpoint 文件正常落盘。

**依赖**：新增 `@langchain/langgraph-checkpoint-sqlite@1.0.4`

**提交**：（见 git log）

---

## V3 —— Interrupt 逐天人工确认（human-in-the-loop）

**目标**：用 LangGraph 的 `interrupt()` 实现「每排完一天暂停、等用户确认」的人机协作，这是手写版最难实现、图结构最自然表达的能力。

**实现**：
- 新增 `reviewDay` 节点：`interrupt({ dayIndex, summary, question })` 暂停图执行，
  把当天摘要抛给前端。
- 状态新增 `pendingDaySummary` 字段（标量字符串，覆盖式）。
- 上下文新增 `reviewMode` 布尔。false（默认）时 reviewDay 节点透传，行为与 V1/V2 完全一致；
  true 时逐天暂停。
- 新增 `resumeTripReview(tripId)`：用 `Command({ resume: 'approved' })` 恢复图，
  从 interrupt 处继续排下一天（复用同一 thread_id = tripId，checkpointer 保证断点接续）。
- 新增路由 `POST /trips/:id/review-confirm` 与 `generate` 的 `mode: 'review'`。
- review 模式是图版专属：即使 `USE_LANGGRAPH` 未开，`mode=review` 也强制走图版。

**关键语义澄清**：
- `graph.invoke()` 在 interrupt 处返回，结果带 `__interrupt__` 数组——这**不是失败**，
  所以 catch 分支不能把 status 设 failed。代码里显式检查 `__interrupt__`，把摘要写进
  `genProgress`（`待确认：第N天 ...`），status 保持 generating。
- resume 后可能又在下一轮的 reviewDay 暂停，所以 `resumeTripReview` 同样要处理
  「再次中断」的情况。

**验证**：
- `npm run check:graph` 扩到 13/13（新增「interrupt 结构化负载」3 条断言）。
- 端到端：`mode=review` 触发后，每天结束停在「待确认」，review-confirm 恢复，
  循环直到全部排完。

**提交**：（见 git log）

---

## V4 —— 回退纠错 + 并行择优

**目标**：体现 LangGraph 的两个核心优势——条件边的回退表达、节点内的并行生成。

### 回退纠错（条件边表达）

排程失败不再抛错中断整张图，而是 catch 后把失败写进状态（`dayError`/`dayRetryCount`），
条件边据此路由：

- 失败且未超限（MAX_DAY_RETRIES=2）→ 回 `planDay` 重试同一天
- 超限 → `planDay` 内部自行跳过（dayIndex+1、清 dayError、记 warning），不死循环

为什么是「重试当前天」而不是「回退到前一天」：回退前一天会覆盖已落库、
用户可能已确认的结果，风险高收益低；重试当前天已能兜住绝大多数偶发失败
（模型格式错、高德连接中断）。

**附带发现**：LangGraph 默认递归上限 25，路由逻辑写错（如死循环）会在 25 步
抛 `GraphRecursionError` 而不是无限跑——这是天然的安全网。

### 并行择优（可开关）

`ctx.parallelCandidates > 1` 时，同一天并行生成 N 套候选方案，启发式打分择优：

- 每个候选用**独立的 registry 快照**（从主表 clone），避免并行写竞争，
  也让每个候选的选点真正独立；落选候选的 POI 仍合并回主表供后续天复用。
- 打分是启发式而非再调一次模型：`评分均值 × 10 − 通勤总分钟 × 0.5 + 景点数 × 2`。
- 默认 1 = 关闭（行为与 V1 一致、成本不变）；`PARALLEL_CANDIDATES=2` 开启。

**诚实说明**：这里用的是节点内 `Promise.allSettled` 并行，而不是 LangGraph 的
`Send` fan-out——因为候选生成共享 ctx（registry、进度上报），图级 fan-out
需要把 ctx 拆到子图去，改动大、收益有限。并行语义已经达成，实现更简单。

**验证**：
- `npm run check:graph` 扩到 19/19（新增「回退纠错」6 条断言：重试成功推进、
  超限跳过不死循环、失败清空等）。
- 端到端：`PARALLEL_CANDIDATES=2` 真实生成成功。

---

## V5 —— 决策可视化 + 收尾

**目标**：让用户能看到「AI 是怎么排的」——这不只是炫技，而是建立信任：用户看到体裁判定、
并行择优、跨天传导这些真实决策，才会相信行程不是随机生成的。

**实现**：
- Prisma 迁移 `20260912041054_add_gen_decisions`：Trip 新增 `genDecisions`（JSON 数组字符串）。
- `createDecisionRecorder()`：读-改-写追加决策（上限 50 条防膨胀），写失败不影响主流程。
- 三个关键决策点落记录：
  1. 锚点确定（「住宿锚点选在 X：理由」）
  2. 体裁判定（「第 N 天体裁判定为 theme_park（强度 heavy），安排 1 个地点」）
  3. 并行择优（「第 N 天并行生成 2 套方案，择优选用评分最高的一套」）
- 生成过程中的实时进度（`genProgress`）本身已含决策信息（搜索哪个景点、规划哪段路线），
  两者配合：过程看 genProgress，结果回看 genDecisions。

**最终验证矩阵**：

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npm run check:graph`（图拓扑/checkpointer/interrupt/回退/并发） | 19/19 |
| `npm run check:scheduler`（规则层纯函数） | 65/65 |
| `npm run smoke`（端到端，含真实模型+高德） | 77/77 |
| 图版真实生成（USE_LANGGRAPH=1） | 成功 |
| 图版逐天确认（mode=review） | 三天各暂停/确认一次 |
| 图版并行择优（PARALLEL_CANDIDATES=2） | 三天各并行 2 套、择优落库 |
| 决策记录落库（genDecisions） | 正常追加 |

---

## 总结：这一轮重写到底带来了什么

| 能力 | 手写版 | LangGraph 版 |
|---|---|---|
| 按天循环 | for 循环 | 条件边（可读、可扩展） |
| 断点续跑 | 天级（Prisma 落库） | 节点级（SQLite checkpointer + Prisma 双保险） |
| 人工介入 | 无（只能事后换点） | interrupt 逐天确认，Command(resume) 恢复 |
| 失败处理 | 整趟失败停下 | 节点级重试（最多 2 次）+ 超限跳过继续 |
| 多方案择优 | 无 | 并行 N 套启发式择优（可开关） |
| 决策可回看 | 只有日志 | genDecisions 落库 |
| 递归死循环防护 | 无 | GraphRecursionError 天然安全网 |

**没有变化的**（这是刻意为之）：评分门槛、营业时间校验、天型判定、黑名单、
夜生活去重、真实通勤体检——这些是项目真正的护城河，全部原样复用
`scheduler.ts` / `spot-rules.ts`，并由 65 条断言持续守护。

## 后续可选方向

1. **前端接入 review 模式**：`mode=review` + `review-confirm` 接口已就绪，
   前端加一个「逐天确认生成」入口和确认卡片即可上线。
2. **genDecisions 前端展示**：详情页加一个「AI 决策回看」折叠面板。
3. **LangSmith 追踪**：配一个 Key 就能看到每一步的完整 trace，调试体验质变。
4. **PostgreSQL 上线时**：checkpointer 从 SQLite 换 `@langchain/langgraph-checkpoint-postgres`。
