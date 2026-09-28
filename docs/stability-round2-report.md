# Stability round 2 验收记录

本轮工作在共享工作树上完成，保留了其他代理的前端和生命周期测试改动；验证范围、数据安全证据和集成边界记录如下。

## 1. 修复映射

- `apps/server/src/services/agent/run-lock.ts`：用户级唯一运行锁、stale 心跳接管、`waiting/reviewing/recovery/commit_pending` 阶段、损坏 journal 降级和安全取消。
- `apps/server/src/services/agent/graph-run.ts`：真实 `buildAgentGraph` 运行时、`${tripId}:${runId}` checkpoint 线程、条件写 fencing、pending journal 无模型重试、warnings 和配置的事务清理、完整行程零模型短路。
- `apps/server/src/services/agent/graph.ts`：自动与人工提交共享 commit journal，累计 warnings 保序去重，完整行程从 `START` 直接 finalize，避免第 N+1 天和未解析住宿触发模型。
- `apps/server/src/routes/trips.ts`：领取后异常释放、reviewId 必填、restart 保存数据保护、`replan-copy` 安全重规划入口、cancel-generation 对静止 pending/recovery 的处理。
- `apps/server/prisma/migrations/20260928090000_run_lifecycle/migration.sql`：旧 review、孤立 review 和重复活动锁的迁移规则。
- `apps/server/src/config.ts`、`apps/server/src/index.ts`、`apps/server/scripts/check-proxy.ts`、`apps/server/.env.example`：默认不信任代理、数字 hop、CIDR/loopback 与真实 Express 限流验证。
- `apps/web/src/api/trips.ts`、`apps/web/src/pages/NewTrip.tsx`、`apps/web/src/pages/TripDetail.tsx`、`apps/web/src/pages/TripList.tsx`：配合 reviewId、replan-copy、生成状态和真实路线/打卡入口；本轮由前端代理维护，未由本执行覆盖。
- `tools/test-isolated.mjs`、根/服务端 `package.json`、`apps/server/scripts/check-migration.ts`、`check-replan.ts`：隔离数据库、离线外部凭据、迁移和重规划验收。

## 2. 运行阶段和数据安全规则

`running` 表示持锁执行；`waiting` 保留人工裁决和 checkpoint，不因 TTL 接管；`reviewing` 与 `genReviewId` 组成一次性裁决领取；`recovery` 需要人工取消后补缺；`commit_pending` 保存完整的已生成天和累计 warnings，合法 journal 的 stale owner 可以被同一行程重新领取并完成数据库提交。损坏 journal 转为 `recovery`，取消只清运行元数据，不删除已保存日期或打卡。

自动模式和 approve/choose 都在写 `TripDay` 前保存 pending journal。`persistDay` 在同一事务内先做 owner fencing，再更新进度、warnings、review 和配置，并保护已有日期/打卡。提交失败后的 continue 读取 journal，不重新调用模型；成功后在同一事务移除 journal。

已有日期的 `restart` 返回 409；`replan-copy` 只复制基础行程字段创建新草稿，原行程完全保留。所有日期已保存的 continue 在读取模型凭据、天气和图上下文前直接收尾为 ready。

## 3. 已执行命令和结果

以下命令均在当前工作树执行，常规回归使用临时 SQLite，不读取或修改开发库：

- `npm run typecheck`：server 和 web 均通过，exit 0。
- `npm test`：SSRF/限流 51/51、run-lock 20/20、agent 19/19、parser 14/14、scheduler 规则 9/9 与选点质量 65/65、graph 19/19、lifecycle 133/133、proxy、migration、replan 均通过，exit 0。
- `npm run build`：server `tsc` 与 web `vite build` 均通过，exit 0；Vite 仅报告现有大 chunk warning。
- `npm run ci`：首次测试子进程在 run-lock 已打印 20/20 后出现 Windows 原生退出码 `3221225477`，没有断言失败；立即完整重跑通过（exit 0），lifecycle 133/133。
- 前端完成态文案修正后的最终 `npm run ci`：exit 0；完整 stdout/stderr 在 `.planning/stability-round2/final-ci.log`，独立退出码记录在 `.planning/stability-round2/final-ci.exitcode`（值为 `0`）。该轮仍为 SSRF/限流 51/51、run-lock 20/20、agent 19/19、parser 14/14、scheduler 9/9 与质量 65/65、graph 19/19、lifecycle 133/133、proxy/migration/replan 通过；日志只作本地证据，不纳入提交。
- `node tools/test-isolated.mjs npm run check:lifecycle`：最新独立日志 133/133，含 HTTP 并发、stale 接管、review CAS、warnings、restart/replan、pending 提交重试、损坏 journal recovery/cancel 和真实 child process checkpoint 恢复。
- `node tools/test-isolated.mjs npm run check:proxy`：真实 Express fetch，默认不信任伪造 XFF，`1` hop、CIDR/loopback 通过。
- `node tools/test-isolated.mjs npm run check:migration`：空库 10 个 migration、旧 9 migration review/check-in、孤立 review、重复活动锁均通过；Windows 原生 SQLite 失败 DDL 后可能留下临时 fixture 文件句柄清理警告，验收本身 exit 0。
- `node tools/test-isolated.mjs npm run check:replan`：restart 409、原日期/打卡保留、副本独立生成通过。
- `npm exec --workspace @travel/server prisma validate`：当前 Prisma schema valid，exit 0。
- `SMOKE_GENERATE=1 npm run smoke`（使用独立 fixture 的 `APP_BASE`/`API_BASE`、浏览器和临时测试账号）：真实模型、高德 Web 服务、JS 地图和 Chrome smoke 通过 77/77，exit 0；截图保存在 `C:\Users\22088\AppData\Local\Temp\travel-real-smoke-466c29a204f64beb87c49536ff77cd07\shots`。
- 独立 review/partial API smoke：真实首日 `waiting` → `reject` 后重排再次 `waiting` → 临时无效模型 Key 让第 2 天三次真实 401 并进入 `partial`（1/2）→ 恢复加密配置后 `continue` 脚本 exit 0，终态 `ready` 且两天落库。fixture 为 `C:\Users\22088\AppData\Local\Temp\travel-real-review-e8b8e5e755c740a4a2ca0a7032349a2f`，终态 `genDecisions` 保留驳回重排与 partial 摘要；首次 Node helper 的 Windows `npm.cmd` 恢复子进程返回 null，随后用同一 fixture 的安全外部恢复命令成功，未改变验证结果。
- 迁移只读审计日志：`.planning/stability-round2/migration-dev-snapshot.log` 与 `.planning/stability-round2/migration-fresh-diff.log`；日志文件只作本地证据，不纳入提交。

## 4. 生产 Graph/checkpoint 范围

生产路由使用真实 `buildAgentGraph`、真实 `SqliteSaver` 和线程 `${tripId}:${runId}`。lifecycle 同时覆盖关闭 runtime 后用同一 checkpoint 文件创建新 runtime，以及独立 child process 关闭/重启后恢复人工裁决并以 exit 0 完成；普通崩溃从数据库事实补缺，人工 interrupt 才从持久 checkpoint 继续。pending journal 重试是数据库提交重试，不是 checkpoint 节点重放。多实例部署仍未在本轮验证。

## 5. 迁移和开发库摘要

空库及旧 9 migration fixture 均在临时数据库验证。旧 review/check-in 保留并转 recovery；`genReview` 有值但 `genRunId` 为空的旧孤立行也转 recovery；同用户重复活动锁拒绝迁移且不删除行。

本地开发库在迁移前快照为 `C:\Users\22088\AppData\Local\Temp\travel-dev-backup-F2zNVT\dev.db.snapshot.sqlite`，大小 487424 bytes。迁移前摘要：Trip 94、TripDay 90、TripItem 350、checkedAt 0，活动运行 0、活动用户 0、重复活动锁 0，SHA-256 `42b69d2379962185a5fd43457be528fb4117c1afabac138ea5b75e560daf6293`。已执行 `npm exec --workspace @travel/server prisma migrate deploy` 和 `npm exec --workspace @travel/server prisma generate`；迁移后 lifecycle 四列均存在，TripDay/TripItem 原列 hash 完全一致，Trip 原列只有 1 行因孤立 review 被合法转换为 recovery 文案，按该转换归一化后原列 hash 一致；TripItem 的 350 个 `checkedAt` 均为空且 hash 一致。独立 fresh SQLite 的 10 条 migration 通过 `prisma migrate diff --exit-code 0`，输出 `No difference detected`。

## 6. 尚未宣称的范围

默认回归会清空可选 Amap/model 环境变量，避免额度消耗；它不是真实外部 API smoke。随后本轮从已迁移开发库用 `VACUUM INTO` 建立独立 fixture，复制现有加密模型配置给临时账号，启动独立 server 和当前 web Vite，并执行了真实 smoke：杭州解析、高德酒店搜索、JS 地图和标记、真实模型三天生成、打卡/替换/路线闭环、设置页和运行时报错检查共 77/77 通过；另以第二个独立 fixture 验证了 review 驳回重排、外部模型失败进入 partial、恢复配置后 continue 到 ready。真实 smoke 的临时数据库和截图路径已记录在上一节，凭据文件已清空且没有输出密钥。前端真实浏览器覆盖了新建向导、住宿地图、行程列表、详情页打卡/替换/闭环路线、设置页和双主题；ready 3/3 的进度与文案已改为明确完成，web typecheck/build 与最终 CI 均通过。一个用于复核该 ready 卡的临时路由 fixture 在登录/住宿选择处未完成，因此不计入验收数字；既有隔离 fixture 与真实 77/77/API 证据仍按上一节记录。视觉改版的后续规划记录在 `docs/frontend-refresh-plan.md`。多实例部署、网络抖动和真实服务配额仍需单独验证；前端不需要 `apps/web/.env` 才能完成本次 smoke，地图配置由 server 接口提供。首次 CI 的 Windows 原生退出码 3221225477 已记录为环境偶发风险，随后立即完整重跑通过（exit 0）。按用户原范围延期的架构工作包括 Redis/独立 Job Queue Worker/GenerationRun、PostgreSQL、全面模块拆分、缓存 LRU、antd 大规模重构和无关性能优化；全面视觉与移动布局实施仍按 `docs/frontend-refresh-plan.md` 规划。

## 7. 工作树状态

基线 commit 为 `5155609`（main）。本轮改动与其他代理的前端和 `check-lifecycle.ts` 共同组成共享工作树的变更；集成只保留本地 Git 记录，不包含推送、部署或真实生产库提交。最终 commit SHA 和工作树状态由提交后的 Git 命令回报，避免将自身 SHA 写入同一提交。

## 8. 本地启动和核验步骤

1. 备份开发库后，在项目根执行 `npm exec --workspace @travel/server prisma migrate deploy` 和 `npm exec --workspace @travel/server prisma generate`。
2. 执行 `npm run typecheck`、`npm test`、`npm run build`；需要一条命令时执行 `npm run ci`。
3. 启动 `npm run dev`，用浏览器打开前端，登录后创建空草稿并生成；已有日期的重新规划先调用 `POST /api/trips/:id/replan-copy`，再对返回草稿调用 generate。
4. 真实 smoke 需在确认前后端可访问、浏览器和模型/Amap 配置均可用后显式设置 `SMOKE_PASSWORD`，并使用独立 fixture 数据库；`SMOKE_GENERATE=1` 才会触发真实模型和高德额度，默认 checks 不会触发外部额度。
