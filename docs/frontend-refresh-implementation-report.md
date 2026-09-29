# 安全恢复与前端改版实施报告

日期：2026-09-29。基线：`0f73f13caa0d1d147a9d4e9e9c6cd8c22281af82`。视觉方向为「清爽旅行风：暖白底、自然色、清晰卡片」。本报告对应的实施提交 SHA 见文末；报告自身提交与 GitHub 推送结果以最终交付消息和远端 `main` 为准。

## 安全恢复与数据边界

- `apps/server/src/routes/trips.ts` 增加需认证和行程归属校验的 `POST /api/trips/:id/recover-generation`。打开详情的 GET 仍只读；用户点“检查中断状态”才检查并推进异常状态。列表 API 也返回 `genRunPhase`。
- `apps/server/src/services/agent/run-lock.ts` 在同一数据库事务内判定阶段、心跳和运行归属：活跃 `running/reviewing` 不抢占；`waiting` 不按心跳超时；过期运行者或无运行者的 `generating` 进入 `recovery`；有效 `commit_pending` 保留待提交结果；损坏或冲突的 journal 进入人工处理的 `recovery`。原子条件更新清除过期归属，重复检查不启动模型。
- `apps/server/src/services/agent/pending-commit.ts` 用完整结构校验验证 dayIndex、天型、强度、条目必需字段、枚举、有限数值、warnings，并比对 `genReview` 与 `genRunConfig.pendingCommit` 两份持久化结果。`items:[{}]` 和两份冲突结果不得自动提交。`graph-run.ts` 统一使用同一解析逻辑；有效 journal 的重试仅提交已保存结果，不再次调用模型。
- `apps/web/src/pages/NewTrip.tsx` 与 `TripDetail.tsx` 接入显式恢复检查、取消异常待确认任务和按真实缺失日期补齐的入口；`GenerationStatusTag.tsx` 统一列表、新建、详情的阶段标签。`recovery` 不显示为普通生成，`commit_pending` 显示为保存待重试。取消与补缺保留已有日期和打卡。

本轮未改数据库 schema 或新增迁移。沿用现有 Prisma/SQLite 运行锁与 LangGraph checkpoint；没有加入 Redis、队列或独立 Worker。自动化覆盖的是本机隔离 SQLite、真实 HTTP 路由、生产 Graph 与持久化 checkpointer 的路径，并未进行多实例部署验收。

## 视觉与页面

Ant Design 仍是组件基础。`main.tsx` 和 `index.css` 统一字体、4px 间距、12px 卡片圆角和两套主题 token。白天：canvas `#F8F7F3`、surface `#FFFFFF`、ink `#263A32`、forest `#2F7058`、lake `#416F8B`；深色：canvas `#141B18`、surface `#1D2622`、ink `#EDF4EF`、forest `#8ED0AD`、lake 使用深色相应强调色。交互边界采用比非交互卡片更强的描边。已移除全屏风景、玻璃和纸质装饰 CSS，删除 `paper.tsx`，保留系统中文字体与原有主题状态。重复使用的表单分区和生成状态标签分别抽成 `FormSection`、`GenerationStatusTag`。

| 页面 | 改版前 | 现在 |
| --- | --- | --- |
| 登录 | 风景/玻璃背景 | 暖白背景、居中表单卡片；认证逻辑未改 |
| 设置 | 视觉与布局不统一 | 普通表单分区，主题选项和小屏布局一致 |
| 我的行程 | 牛皮纸书签式列表 | 目的地、状态、日期与操作分层的 Ant Design 卡片；独立键盘可达按钮 |
| 新建行程 | 显示四步但实际只有三步，表单内部限高 | 真实三步、自然滚动；住宿候选优先，手机地图按需展开；生成阶段集中说明下一步 |
| 行程详情 | 线圈本、便利贴、双栏锁高 | 日程时间轴卡片与桌面地图双栏；手机完整日程与可展开地图，日次自身横向滚动 |

共享状态展示综合行程 `status` 与 `genRunPhase`；完成数和缺失日取服务端派生值，不用 `genDayIndex` 猜测。待确认、正在处理确认、恢复、保存重试、部分完成和已完成各有明确文字。原有打卡、换一个、交通方式、路线、逐天裁决与副本重新规划入口保留。

## 验证证据

- 根目录 `npm run typecheck`：退出码 0。
- 根目录 `npm run test`：隔离 SQLite 检查通过；新增最后两个恢复边界前生命周期检查为 165/165。新测试先暴露无运行者但残留新心跳的问题（165/167），修复后 `check:lifecycle` 为 **167/167**。
- 根目录 `npm run build`：前后端构建通过。
- 最终根目录 `npm run ci`：退出码 **0**，串行执行 typecheck、隔离 `npm run test` 和 build；生命周期真实链路 **167/167**，可信代理检查、旧数据迁移检查、重新规划检查均通过。迁移检查成功后 Windows 临时 fixture 清理出现一次 `EBUSY` 延后提示，不影响检查退出码，也未触碰开发库。
- 生命周期覆盖：活跃/等待任务不被恢复抢占，过期及无运行者任务显式恢复，损坏/冲突 journal 不自动生成，恢复请求并发与跨用户归属，取消后保留已保存日程和打卡；既有测试覆盖同 Trip/同用户并发、重复裁决、失锁迟到结果、重启 checkpoint、失败提交 journal 只重试保存、partial 补缺等真实生产路径。
- Chromium 隔离 fixture：登录、列表、新建、设置、详情 5 页 × 日夜 × 375/390/768/1024/1440px，共 **50** 组合；另以 **720 CSS 像素视口 + DPR 2** 模拟 1440 宽度下 200% 重排，10 组合。记录均无整页横向溢出或页面异常；五天日程末尾可达，手机地图展开成功。这是等效重排检查，**未执行浏览器原生 200% 缩放**。记录保留在本地 `.planning/frontend-refresh-goal/visual-results.jsonl`，未提交测试 fixture。
- Mock 高德浏览器流程验证住宿搜索、键盘选酒店并进入生成阶段；390px 地图高度 320px、1440px 为 520px。隔离行程打卡 1/4→2/4→1/4、切第 5 天和展开地图通过。真实高德、真实模型完整生成、真实路线与“换一个”外部服务调用因缺少凭据未执行，不能据此宣称外部服务联调通过。
- Chromium 计算样式对比度：白天正文 11.3:1、主按钮 5.87:1、placeholder 5.25:1、输入框边界 3.53:1；深色分别 15.66:1、6.98:1、7.74:1、7.5:1。状态 Tag 文字 11.79:1 / 14.64:1，下拉文本 12.11:1 / 12.13:1。非交互卡片细描边不承担控件识别职责。

关键截图（均为隔离 fixture，保存文件已与测试原图逐一核对 SHA256）：[手机详情白天](screenshots/frontend-refresh/detail-day-390.png)、[手机详情黑夜](screenshots/frontend-refresh/detail-night-390.png)、[手机展开地图](screenshots/frontend-refresh/detail-map-day-390.png)、[桌面详情](screenshots/frontend-refresh/detail-day-1440.png)、[手机新建](screenshots/frontend-refresh/new-day-390.png)、[桌面住宿](screenshots/frontend-refresh/stay-day-1440.png)、[手机生成](screenshots/frontend-refresh/generation-day-390.png)、[桌面列表](screenshots/frontend-refresh/trips-day-1440.png)、[桌面设置黑夜](screenshots/frontend-refresh/settings-night-1440.png)、[登录黑夜](screenshots/frontend-refresh/login-night-390.png)。目录还包含各主要页面的日夜与桌面/手机对照图。

## 本地运行与后续范围

按 README 配置 `apps/server/.env`、`apps/web/.env`，在项目根目录运行 `npm install`、`npm run db:migrate`、`npm run dev`；浏览器访问开发服务器，使用测试账户从登录、新建、住宿、生成、详情检查操作。需要完整真实链路时再填入模型与高德凭据。自动化验证使用 `npm run ci`，其中数据库检查由 `tools/test-isolated.mjs` 创建临时库。

本轮没有进一步做多实例运行锁、任务队列、真实 API 的旅行质量/耗时/额度评估，也没有原生 200% 缩放实测。后续应在具备隔离账号与凭据时做完整外部联调和旅行规划质量评测；这些不影响本次本地恢复与视觉验收结论。

实施提交 SHA：`2c21286ac0aa74cfddab56989d858f390a8f3f91`。报告提交前工作区另有本次临时验证资料 `.planning/frontend-refresh-goal/` 与用户原有未跟踪 `.serena/`；两者均不纳入提交。推送后远端状态以实际 Git 核对结果为准。
