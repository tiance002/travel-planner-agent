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

## V2 —— Checkpointer 断点续跑（规划）

接入 SQLite checkpointer，把断点从「天级落库」升级到「节点级快照」。

## V3 —— Interrupt 人机协作（规划）

生成前确认摘要 + 换点人工审核。

## V4 —— 并行择优 + 回退纠错（规划）

同一天 fan-out 并行生成多方案择优；某天失败自动回退。

## V5 —— 状态可视化 + 文档收尾（规划）

生成过程决策步骤下发前端 + 完整文档。
