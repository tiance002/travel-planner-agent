# 旅游助手关键缺陷修复与 MVP 稳定性验收报告

- **工作基线**：`caf109f9087c3ace013fe479f556229845115137`
- **本次提交**：`5c8e55906defa4768d59075d4eff29d9e916b311`（本地，**未推送 / 未部署**）
- **验收目标**：单实例、受控用户下的 **MVP 稳定性**，非多实例生产级验收
- **范围**：8 个确定性缺陷修复（任务 1–8）+ 回归测试（任务 9）

---

## 一、修复摘要

### 安全

**任务 1 — SSRF 防护补全**

问题：`utils/ssrf.ts` 只校验了 `URL.hostname` 的字面量，而 WHATWG URL 会把 `http://[::ffff:127.0.0.1]/v1` 归一化为 `[::ffff:7f00:1]`，导致 IPv4 映射环回地址**绕过拦截**；同时探测请求默认跟随重定向，存在「校验目标 A、实际请求 B」的 TOCTOU。

修复：
- `utils/ssrf.ts`：剥离 IPv6 花括号后再判定；新增 `::ffff:xxxx:xxxx` / `::xxxx:xxxx` 十六进制映射识别，转为点分 IPv4 后走原有 `isBlockedIp`。
- `services/llm.ts` `testCredentials`：`fetch` 改 `redirect: 'manual'`，并显式拒绝 3xx。
- `services/agent/model-client.ts` `requestOnce`：同上，3xx 视为不可重试错误。

> 该缺陷是被新增测试**真实捕获**的（见验证结果：修复前 51 项中「拒绝 IPv4 映射的环回」失败）。

**任务 3 — 限流按可信 IP 计算**

问题：`clientIp()` 优先取 `X-Forwarded-For` 第一段，等于把限流身份键交给客户端——伪造 XFF 即可不断换桶、绕过限流。

修复：
- `middleware/rate-limit.ts`：`clientIp()` 只信 `req.ip ?? req.socket.remoteAddress ?? 'unknown'`，不再自解析 XFF。
- `config.ts` 增 `TRUSTED_PROXIES`；`index.ts` 仅在配置非空时 `app.set('trust proxy', ...)`（**刻意不用 `true`**）。反代支持收敛为一行显式配置。
- `rateLimit()` / `concurrencyGuard()` 返回类型显式标注为 `RequestHandler`（规避 Express 5 变参重载的类型退化）。

### 并发与任务生命周期

**任务 2 / 7 — 真实任务并发锁 + 僵尸任务判定（新增 `services/agent/run-lock.ts`）**

问题：原并发控制挂在 HTTP 中间件上，只能覆盖「请求开始→响应结束」；但生成接口立即返回 202、任务在后台跑几十秒——响应一结束计数即归零，连点即可并发生成多张图。且原「固定超时」会误判仍在等待用户确认的长任务为僵尸并夺权。

修复：
- **锁粒度 = 任务本身**：Trip 增 `genRunId`（谁在跑）、`genHeartbeatAt`（最近心跳）、`genRunStartedAt`，迁移 `20260927082625_add_gen_run_lock`，附 `@@index([status, genHeartbeatAt])`。
- **原子抢锁**：`acquireRun` 用条件 `updateMany`（`WHERE OR[genRunId null / heartbeat null / heartbeat < now-TTL]`），把判断与写入放进同一条 SQL；行程级 + 用户级双互斥。
- **心跳存活**：TTL 90s、间隔 20s；任务活着就一直续心跳，**跑一小时也不会被判僵尸**（等待人工裁决期间锁持续持有）。
- **僵尸判定改为「心跳过期」**，不再用固定超时夺权（任务 7 明确禁止）。
- **归属守卫**：`heartbeatRun` / `releaseRun` / `isRunOwner` 全部带 runId 条件；失去锁的运行不再写库。`finally` 中释放锁，覆盖正常/失败/异常三条路径。
- `routes/trips.ts` 与 `graph-run.ts` 全面接线；`STALE_GENERATING_MS` 不再用于夺取所有权。

**任务 6 — 重复裁决拦截**

问题：同一张「待确认」卡片被并发/重复点击时，可能被恢复多次。

修复：`review-confirm` 以 `genReview: { not: null } → null` 的原子条件更新认领，认领失败即 409；`resumeTripReview` 内再做一次同样的原子认领。

### 一致性

**任务 5 — 断点续跑只补缺失日，不覆盖已有天**

问题：原恢复逻辑从「第一个缺失日后一路重排」，会覆盖用户已确认的后续天。

修复：`graph-state.ts` 增 `gapDays: number[]`（已落库的天）；`planDay` 顶部命中即跳过（不调模型、不落库、不消耗额度），只推进游标。验证用例证明「第 1、3 天已有 → 只补第 2 天，第 3 天内容与条目原样保留」。

**任务 8 — 单天提交与 warnings 一致**

问题：`commitDay` 只写「当天的」warnings，每提交一天就覆盖前几天——用户最后只看到最后一天的问题；且图状态与 DB 分叉。

修复：`commitDay` 改为 `dedupeWarnings([...state.warnings, ...warnings])` 累积后落库，并把累积结果写回图状态；`finalize` 回查**实际落库天数**判定 `ready` / `partial`，`partial` 时在 `genError` 中说明缺失的天。

**任务 4 — 详情页轮询启动**

问题：轮询启动条件用组件本地状态预判；首次打开一个「正在生成」的行程时数据尚未加载（trip 为 null），判为不启动，而 effect 依赖只有 tripId 不再触发——首屏静止。

修复：`useGenerationPolling` 改为**先无条件拉一次**，用**服务端返回的状态**决定是否续；请求失败（null/抛错）继续重试自愈；终态停表。`TripDetail.tsx` 同步调用；`NewTrip.tsx` 加 `MAX_POLL_FAILURES = 5` 容错。

---

## 二、验证结果

全部命令在项目根目录执行，**均 EXIT=0**：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | server + web 均 0 错误 |
| `npm run test` | 见下方逐套件 |
| `npm run build` | 成功（server tsc + web vite） |
| `npm run ci` | typecheck → test → build 全绿，EXIT=0 |

### 测试套件明细

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `check:ssrf` | **51/51** | SSRF 拦内网/环回/链路本地/云元数据、IPv4 映射 IPv6、重定向不跟随；限流按可信 IP |
| `check:runlock` | **17/17** | 行程级/用户级互斥、原子抢锁、心跳续期、僵尸接管、只有持锁者能写（真实数据库） |
| `check:agent` | **19/19** | 驱动**真实 `buildAgentGraph`**：三天全自动落库→ready、断点补缺不覆盖、全断点不重排、warnings 跨天累积、partial 判定、重排替换而非追加 |
| `check:parser` | 14/14 | 模型 JSON 毛边形态 |
| `check:scheduler` | 9/9 | 排程规则 |
| 选点质量与天型 | 65/65 | 天型/强度/去重/评分闸门 |
| `check:graph` | 19/19 | LangGraph 拓扑、interrupt/resume、checkpointer |

### 数据库迁移与既有数据

| 场景 | 结果 |
|---|---|
| **全新建库**（`migrate deploy` 到空文件） | 9 个迁移全部成功；`gen*` 三列齐全 |
| **现有库升级** | dev.db 应用同一迁移后，`gen*` 列与新建库完全一致 |
| **既有数据可读** | 7 用户 / 94 行程 / 363+ 条目全部可读，样本行程可正常读出 |
| **schema ↔ 迁移同步** | `prisma migrate diff --from-migrations --to-schema` 输出为空迁移（已同步） |

> **未覆盖的验收**：本轮未做多实例并发压测，也未做 GitHub Actions CI（本地 `npm run ci` 只是脚本串联，不是 CI 流水线）。

---

## 三、关键证据

1. **SSRF 测试真实抓到 bug**：修复前 `check-ssrf` 报「拒绝 IPv4 映射的环回」失败（期望拒绝、实际放行），补上 IPv6 映射识别后 51/51。
2. **生产图测试非「形似重写」**：`check-agent.ts` 向 `AgentGraphContext` 注入 mock `chatClient` / `toolRunner`，驱动**同一份** `buildAgentGraph` 跑完，断言打在**真实数据库落库结果**上（对比旧的 `check-graph.ts` 另造结构相似的图）。
3. **断点续跑关键断言**：`第 3 天未被覆盖（关键：不覆盖后续已有天）`、`第 3 天的原有条目仍在` 均通过。
4. **warnings 跨天累积断言**：`第 1 天的 warning 跨天保留了下来` 通过（读 `Trip.genWarnings` 验证第 1 天的提示在第 2 天提交后仍在）。
5. **自检脚本零残留**：跑完后确认 `0 测试用户 / 0 测试行程`；异常路径按 `TripItem → TripDay → Trip → User` 显式清理。

---

## 四、剩余风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 任务锁非分布式 | DB 锁在**单实例**下正确；多实例并发不具备跨进程原子性 | 多实例前必须换 Redis 锁 |
| 限流为单进程内存 | 重启清零、多实例各算各的 | 单实例够用；多实例换 Redis |
| SSRF 非生产级 | **DNS Rebinding 的 TOCTOU 窗口无法完全消除** | 已在探测/模型调用处禁用重定向；面向公网前应加网络出口策略 |
| 无自动重调度 | 进程被强杀后需用户重新点击生成（靠僵尸接管恢复） | MVP 可接受；生产需 Job Queue |
| SQLite 单文件 | 并发写能力有限 | 高并发需迁 PostgreSQL |

---

## 五、延期事项（本轮明确不做）

- 多实例分布式锁（Redis）。
- 完整 GenerationRun 表 + Job Queue / Worker。
- PostgreSQL / Redis / 对象存储迁移。
- 完整缓存 LRU 策略。
- antd 全量按需引入优化（~1MB，侵入式重构）。
- 大目录 / 大模块拆分。
- GitHub Actions CI workflow 文件。

---

## 六、Git 信息

```
基线    caf109f9087c3ace013fe479f556229845115137
本次    5c8e55906defa4768d59075d4eff29d9e916b311
状态    本地提交，未推送、未部署
改动    16 个文件修改 + 5 个新增（含 1 个迁移）
```

新增文件：
- `apps/server/src/services/agent/run-lock.ts`
- `apps/server/prisma/migrations/20260927082625_add_gen_run_lock/migration.sql`
- `apps/server/scripts/check-ssrf.ts`、`check-runlock.ts`、`check-agent.ts`

---

## 七、运行说明

```bash
# 依赖与数据库
npm install
cd apps/server && npx prisma generate && npx prisma migrate deploy && cd ../..

# 开发
npm run dev

# 全量验证（本地）
npm run typecheck
npm run test      # 六套自检脚本
npm run build
npm run ci        # = typecheck && test && build

# 单独跑本次新增的自检
npm run check:ssrf
npm run check:runlock   # 需要数据库
npm run check:agent     # 需要数据库；零网络、零模型额度
```

环境变量新增：`TRUSTED_PROXIES`（**留空 = 不信任任何 XFF**，只在确实部署在可信反代之后时设置）。

---

## 八、MVP 验收结论

**通过（有条件）**。

8 个确定性缺陷均已修复并通过可复现的回归测试；`npm run typecheck / test / build / ci` 全绿；迁移在新建库与既有库两条路径上均验证通过，既有用户数据完整可读、未被触碰。

需要明确的前提：本结论适用于**单实例、受控用户**的 MVP。它**不等于**多实例生产级验收——分布式锁、Job Queue、PostgreSQL 三项属延期范围，上线多实例前必须补齐（见剩余风险）。
