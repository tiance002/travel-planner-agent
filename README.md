# Travel Planner Agent

一个基于 AI Agent 的旅游规划 Web 应用。用户提交目的地、日期、天数、人数、偏好与预算后，系统以**住宿地点为锚点**，结合高德地图 POI 数据与实时天气，生成按天编排的行程，并在地图上展示路线、支持到点打卡。

> 主体功能已完成（P1–P18），当前处于上线前的打磨阶段。

## 核心特性

- **账号体系**：用户名 + 密码注册登录，JWT 会话，密码以 scrypt 加盐哈希存储；支持修改头像、用户名与密码
- **四步新建行程**：基本信息 → 内嵌地图选定住宿 → AI 生成 → 结果查看
- **两档生成模式**：全自动一次排完，或「逐天确认」——每排完一天暂停，由你确认采用、驳回重排或二选一
- **并行择优**：可选每天并行生成 2 套方案，按评分、通勤与景点数打分取优（模型消耗与耗时约翻倍）
- **住宿锚点排程**：以住宿为圆心，直线距离排序聚类，高德路径规划生成真实路线与通勤时间
- **智能组合**：每天景点上限 3 个，餐厅就近插入相邻景点之间，不单独占时段
- **营业时间避坑**：结合 POI 营业时间过滤闭馆日
- **地图联动**：按天展示路线，列表与地图标记双向联动
- **换一个**：对某个地点不满意时，在前后两段通勤都 ≤40 分钟的范围内换同类地点
- **到点打卡**：到地方手动点一下，已打卡条目置灰打勾，当天「当前目标」高亮
- **自带模型密钥**：用户在设置中自行选择模型并填写 API Key，服务端加密托管

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 · TypeScript · Vite 8 · Ant Design 6 · 高德 JS API |
| 后端 | Node.js 22 · Express 5 · TypeScript · Prisma 7 |
| 数据库 | 开发期 SQLite（经 libSQL driver adapter），上线目标 PostgreSQL |
| 数据校验 | Zod 4 |
| AI 编排 | LangGraph 1.4（`@langchain/langgraph`）—— 状态图 + `interrupt` 人工介入，检查点落 SQLite |
| 模型接入 | OpenAI 兼容接口（BYOK：用户自填厂商、`base_url`、模型名与 Key） |
| 地图与 POI | 高德开放平台 Web 服务 API（地理编码 / POI 搜索 / 路径规划 / 天气） |
| 长周期天气 | Open-Meteo（补高德 4 天预报上限，**规划中**） |

### 关于 Prisma 7 的两个注意点

Prisma 7 有两处与网上多数教程不同的破坏性变更，改动是刻意为之，不是配置错误：

1. **连接串不再写在 `schema.prisma` 里**，而是移到 `apps/server/prisma.config.ts` 的 `datasource.url`；`schema.prisma` 的 `datasource` 块只声明 `provider`。
2. **客户端必须显式传入 driver adapter**。项目选用 `@prisma/adapter-libsql`，原因是它依赖平台预编译包，无需 node-gyp 本地编译；而 `better-sqlite3` 需要执行安装脚本（`prebuild-install || node-gyp rebuild`），在 Windows 上更容易失败。

另外，生成的客户端代码位于 `apps/server/src/generated/prisma/`，属于构建产物，已在 `.gitignore` 中排除，需要执行 `prisma generate` 重新产出。

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 项目骨架、账号体系（注册 / 登录 / JWT）、行程列表、数据库迁移 | ✅ 已完成 |
| P2 | 高德能力接入、内嵌地图选住宿、新建行程向导前两步、行程草稿落库 | ✅ 已完成 |
| P3 | 模型配置（用户自填 API Key，服务端 AES-256-GCM 加密托管） | ✅ 已完成 |
| P4 | AI 生成行程（工具调用编排、每日排程规则、按天生成与断点续跑） | ✅ 已完成 |
| P5 | 行程详情页（时间轴 + 地图联动 + 到点打卡） | ✅ 已完成 |
| P6–P7 | 界面改版：布局重构、响应式适配、深色 / 浅色主题 | ✅ 已完成 |
| P8 | 排程质量打磨，引入五种天型与强度区分（主题乐园整天、爬山只排 1 个等） | ✅ 已完成 |
| P9 | 纸质手帐视觉主题落地 | ✅ 已完成 |
| P10 | 编排迁移到 LangGraph：断点续跑 → `interrupt` 人工介入 → 驳回回退 → 并行择优 → 决策落库 | ✅ 已完成 |
| P11 | 交互模式开关上屏（逐天确认 / 并行择优） | ✅ 已完成 |
| P12 | 驳回重排与 A/B 方案对比 | ✅ 已完成 |
| P13 | 通勤耗时恒为 0 的缺陷修复 | ✅ 已完成 |
| P14 | 驾车 / 公交双通勤方案 | ✅ 已完成 |
| P15 | 删除手写编排版本，编排收敛为 LangGraph 单一路径 | ✅ 已完成 |
| P16 | 补充 `docs/项目学习文档.html` | ✅ 已完成 |
| P17 | 死代码与冗余路径精简 | ✅ 已完成 |
| P18 | 仓库隐私审计与凭据加固（移除硬编码测试密码） | ✅ 已完成 |

> 下一步计划：高德 Key 的 IP / 域名白名单配置、注册邀请码与接口限流、数据库迁移至 PostgreSQL。

## 后端接口一览

除 `/api/health` 外，所有接口都要求登录，凭证通过 `Authorization: Bearer <token>` 传递。

### 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册，成功后直接返回登录凭证 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 查询当前登录用户（含头像），用于刷新页面后确认登录态 |
| PUT | `/api/auth/profile` | 修改用户名。会一并返回签给新用户名的新 token，无需重新登录 |
| PUT | `/api/auth/password` | 修改密码，必须先验证旧密码 |
| POST | `/api/auth/avatar` | 从预设列表中选定头像 |
| POST | `/api/auth/avatar/upload` | 上传自定义头像（前端压缩成 dataURL，服务端解码后落到 `uploads/`） |

### 行程

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/trips` | 当前用户的行程列表 |
| POST | `/api/trips` | 创建行程草稿 |
| GET | `/api/trips/:id` | 行程详情，含每日安排与条目 |
| PATCH | `/api/trips/:id/stay` | 写入或清除住宿锚点 |
| POST | `/api/trips/:id/generate` | 触发 AI 生成行程。立即返回 202，进度通过详情接口轮询 |
| POST | `/api/trips/:id/review-confirm` | 「逐天确认 / 并行择优」模式下提交裁决：采用 / 二选一 / 驳回 |
| POST | `/api/trips/:tripId/items/:itemId/checkin` | 到点打卡 |
| DELETE | `/api/trips/:tripId/items/:itemId/checkin` | 取消打卡 |
| GET | `/api/trips/:tripId/items/:itemId/alternatives` | 「换一个」候选列表：可行距离内的同类地点 |
| PATCH | `/api/trips/:tripId/items/:itemId/replace` | 「换一个」执行替换 |
| DELETE | `/api/trips/:id` | 删除行程 |

### 高德能力（后端代理，Web 服务 Key 不出服务端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/amap/config` | 下发地图所需的 JS Key 与安全密钥，**不含** Web 服务 Key |
| GET | `/api/amap/geocode` | 地址 → 经纬度与行政区划编码 |
| GET | `/api/amap/regeo` | 经纬度 → 地址 |
| GET | `/api/amap/poi/text` | POI 关键字搜索（酒店 / 景点 / 餐厅） |
| GET | `/api/amap/poi/around` | POI 周边搜索，结果带直线距离 |
| GET | `/api/amap/weather` | 城市天气预报（高德仅提供约 4 天） |
| GET | `/api/amap/direction` | 路径规划，返回真实距离、耗时与可绘制折线 |

> 高德接口结果带进程内 TTL 缓存（POI 10 分钟 / 天气 30 分钟 / 路径 5 分钟 / 地理编码 24 小时）
> 并对同一时刻的重复请求做了合并，以减少免费配额消耗。

### 模型配置（个人设置页）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings/model` | 查询当前配置。只返回 Key 掩码，**永不回传明文** |
| PUT | `/api/settings/model` | 保存厂商、接口地址、模型名与 API Key。`apiKey` 不传＝保持原值，传空串＝清除 |
| DELETE | `/api/settings/model` | 清空该用户的全部模型配置 |
| POST | `/api/settings/model/test` | 用填入或已保存的凭据发起一次最小对话，验证是否可用 |

> API Key 使用 AES-256-GCM 加密后落库，主密钥来自服务端环境变量 `VAULT_MASTER_KEY`，
> 与数据库分开存放。GCM 自带完整性校验，密文被篡改一个字节即解密失败。
> 用户未配置自己的 Key 时，后端可回退到 `.env` 里的全局默认 Key（`DEFAULT_MODEL_*`）以便开发联调。

### AI 生成

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/trips/:id/generate` | 触发生成。立即返回 202，真实进度与结果通过详情接口轮询 |

请求体可选 `{ "mode": "continue" | "restart" | "review", "parallel": boolean }`：

- `continue`（默认）—— 保留已经排好的天，从第一个空缺的天接着排。失败后重试走这条，不会重跑已经完成的天。
- `restart` —— 清空已有安排，从第 1 天重来。页面上点「重新生成」时用它。
- `review` —— 清空重排，且**每排完一天就暂停等你确认**。点「开始生成（逐天确认）」时用它；
  暂停后由 `POST /api/trips/:id/review-confirm` 提交裁决来恢复。
- `parallel`（默认 `false`）—— 「并行择优」开关：每天并行生成 2 套方案，再按评分、通勤与景点数打分取优，
  模型消耗与耗时约翻倍。

`review-confirm` 的请求体为 `{ "decision": "approve" | "choose" | "reject", "choice"?: "A" | "B", "feedback"?: "...", "parallel"?: boolean }`：
确认采用走 `approve`，二选一走 `choose` + `choice`，驳回则用 `reject` 并可附上意见（会写回图状态，由条件边触发该天重排）。

> 生成是异步的：接口返回后服务端继续跑。行程状态走 `draft → generating → ready / failed`，
> `genProgress` 是当前进度文案、`genDayIndex` 是已完成到第几天（前端每 2.5 秒轮询一次），
> 失败时 `genError` 写明原因，**但已经排好的天会留在库里**。

## AI 是怎么排行程的

给模型的是一套**工具箱**，而不是让它自由发挥。工具由服务端实现，返回的都是高德的真实数据：

| 工具 | 作用 |
|---|---|
| `search_poi` | 按关键词在城市范围内搜景点 / 餐厅 / 酒店 |
| `search_nearby` | 以某个已搜到的地点为圆心找周边，比全城搜更靠谱 |
| `get_route` | 两个已搜到地点之间的真实驾车 / 步行 / 公交方案与耗时 |
| `get_weather` | 目的地未来约 4 天的预报（超出窗口会明确返回「不可用」） |
| `get_city_center` | 城市中心点，供「还没定住宿」时推荐锚点区域 |

三条硬约束**由代码保证，不依赖模型自觉**：

1. **坐标只能来自高德。** 工具只接受 `poiId`，模型手上根本没有坐标可编；落库前再对照一次登记表，查不到的地点直接丢弃。
2. **每天游览类地点不超过 3 个，餐厅插在相邻两个景点之间。** 超量会被裁剪，顺序会被重排；餐厅是否属于餐饮以高德分类编码判定，不信模型自报。
3. **相邻两点实际通勤超过 40 分钟就换点。** 用高德路径规划的真实耗时判断，不够近就从候选池里换一个更近的；确实换不动时保留并在提示里说明。

### 按天生成

生成不是「一次请求吐完整趟行程」，而是**一天一次请求**：

```
确定住宿锚点（未定时由 AI 推荐一次）
   ↓
第 1 天 → 落库 → 第 2 天 → 落库 → …… → 第 N 天 → 落库 → ready
```

这么设计的原因：

- **单次输出小得多。** 早先要模型一次写出多天嵌套的 JSON，天数越多越容易写坏；实测每多写一天，格式出错的概率就往上跳一截。
- **失败范围小。** 某一天排失败时，前面几天已经落库，点「继续」接着排即可，不会把几十次高德查询一起作废。
- **进度看得见。** 前端显示「第 2/3 天已完成」和进度条，而不是一个笼统的「生成中」。

每天仍会带工具跑一次完整循环（搜索、查路线），但对话是独立的——模型不会背着前几天的上下文，
只通过提示词里给出的一份「已安排过的地点」清单来避开重复。

一天大约十到二十秒，会真实调用模型与高德接口十余次。开发期想看完整产出与每天的分段耗时，
在项目根目录执行 `npm run try:generate -- <用户名> <天数>`，
终端会打印每一步工具调用与最终行程（末尾加 `restart` 可验证清空重排）。

### 编排：LangGraph 状态图

生成流程由一张状态图驱动（`apps/server/src/services/agent/graph.ts`），节点只有四个：

```
START → resolveAnchor → planDay → reviewDay ─┬─ 还有下一天 ──→ planDay
                                             ├─ 当天失败 ────→ planDay（重试）
                                             ├─ 被驳回 ──────→ planDay（按意见重排）
                                             └─ 全部排完 ────→ finalize → END
```

- **resolveAnchor** —— 确定住宿锚点。用户没定住宿时，让模型推荐中心区域作为候选。
- **planDay** —— 排一天。带工具跑一次完整循环。
- **reviewDay** —— 裁决这一天。全自动模式下直接透传；交互模式下在这里 `interrupt` 暂停等人。
- **finalize** —— 收尾，把行程状态置为 `ready` 并清空进度字段。

两个值得知道的设计要点：

1. **为什么用图而不是手写循环。** 这套流程需要「跑到一半停下来问用户，问完从原地继续」，
   而「继续」发生时进程可能已经重启。LangGraph 的 **checkpoint（检查点）** 把每一步的图状态
   持久化下来（`thread_id` 就是行程 id），暂停后能精确恢复。手写版本得自己实现这套状态序列化，
   容易出错——**P15 已把手写编排整体删除，现在只有图这一条路径**。
2. **交互模式下 `planDay` 不落库，只把方案挂在图状态里。** 因为驳回重排时，跨天状态
   （已用地点清单、前一天强度、已用夜间类型）已经吸收了这一天的内容，先落库再重排会被
   自己的旧地点「去重」掉、天型传导也会算错。**先挂起、裁决后再提交，状态永远不会倒退。**

### 两种交互模式与并行择优

| 模式 | 行为 | 适合 |
|---|---|---|
| 全自动（默认） | 一口气排完所有天，中途不打断 | 想快速拿到结果 |
| **逐天确认** | 每排完一天暂停，展示这一天供你裁决：确认采用 / 二选一 / 驳回重排 | 对行程质量有要求，愿意多花几分钟 |

**并行择优**是可以叠加在任一模式上的开关：每天同时生成 2 套方案，落地前按
「评分均值 × 10 − 驾车通勤分钟 × 0.5 + 景点数 × 2」启发式打分取优；
逐天确认模式下会把两套并排给你挑（A/B 对比）。代价是模型调用与耗时大致翻倍，所以默认关闭。

驳回时填写的意见会写进图状态，条件边据此把流程送回 `planDay` 重排那一天——
**只重排这一天，前面已经确认过的不受影响**。

## 目录结构

```
.
├─ apps/
│  ├─ web/                          # 前端应用
│  │  └─ src/
│  │     ├─ amap/loader.ts          # 高德 JS API 动态加载（含安全密钥设置时机）
│  │     ├─ api/                    # 后端接口调用封装
│  │     ├─ components/AmapMap.tsx  # 地图的 React 封装
│  │     └─ pages/                  # 登录、行程列表、新建行程、行程详情、个人设置
│  └─ server/                       # 后端服务
│     ├─ prisma/schema.prisma       # 数据模型
│     ├─ prisma.config.ts           # Prisma 7 的连接串配置
│     └─ src/
│        ├─ services/agent/         # AI 生成行程
│        │  ├─ graph.ts             # LangGraph 状态图：节点、条件边、interrupt 裁决
│        │  ├─ graph-state.ts       # 图状态定义（只放可序列化的轻量字段）
│        │  ├─ graph-run.ts         # 图的启动与恢复入口
│        │  ├─ scheduler.ts         # 每日排程规则与模型输出解析阶梯
│        │  ├─ spot-rules.ts        # 选点准入与天型判定
│        │  ├─ alternatives.ts      # 「换一个」的候选搜索与排序
│        │  ├─ tools.ts             # 提供给模型的五个工具
│        │  ├─ prompt.ts            # 提示词组装
│        │  └─ model-client.ts      # OpenAI 兼容接口调用
│        ├─ services/amap.ts        # 高德 Web 服务 API 封装与归一化
│        ├─ services/cache.ts       # 内存 TTL 缓存
│        ├─ services/llm.ts         # 模型凭据读取与连通性测试
│        ├─ utils/vault.ts          # API Key 的 AES-256-GCM 加解密与掩码
│        ├─ routes/                 # 认证 / 行程 / 高德代理 / 模型配置路由
│        └─ middleware/auth.ts      # JWT 鉴权
├─ docs/
│  ├─ 技术方案V1.html               # 初始技术方案
│  ├─ 项目学习文档.html             # 项目原理与实现讲解
│  ├─ langgraph-migration.md        # 编排迁移到 LangGraph 的过程记录
│  └─ 部署指南.html                 # 部署与密钥配置说明
├─ tools/smoke.mjs                  # 端到端冒烟测试脚本
├─ package.json                     # npm workspaces 根配置
└─ apps/server/.env.example         # 环境变量模板
```

## 本地启动

前置要求：Node.js 22 及以上。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp apps/server/.env.example apps/server/.env
# 然后编辑 apps/server/.env，填入两类密钥
#
# 自行生成的两个密钥：
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # VAULT_MASTER_KEY
#
# 高德开放平台申请的三个值（缺了地图与 POI 功能不可用，但不影响账号与行程列表）：
#   AMAP_WEB_SERVICE_KEY / AMAP_JS_KEY / AMAP_JS_SECURITY_CODE

# 3. 初始化数据库（会自动生成 Prisma 客户端并创建 apps/server/prisma/dev.db）
npm run db:migrate

# 4. 同时启动前后端
npm run dev
```

启动后：前端 http://localhost:5173 ，后端 http://localhost:3001 。

> 首次运行 `npm run db:migrate` 需要联网下载 Prisma 的 schema engine，耗时取决于网络状况。

### 自检：浏览器冒烟测试

项目自带一个端到端自检脚本，用 Chrome DevTools 协议真实驱动「新建行程」全流程
（解析目的地 → 搜索酒店 → 地图选点 → 保存草稿），并逐项报告结果、输出截图。

```bash
# 保持 npm run dev 在运行，另开一个终端执行
npm run smoke
```

截图默认输出到系统临时目录的 `travel-planner-smoke/`。脚本会自动注册一个测试账号
（默认 `smoke_bot`）。**测试密码通过环境变量 `SMOKE_PASSWORD` 提供，仓库里不内置**：

```bash
# bash
SMOKE_PASSWORD='你的测试密码' npm run smoke

# PowerShell
$env:SMOKE_PASSWORD='你的测试密码'; npm run smoke
```

其余可用环境变量：`CHROME_PATH`、`APP_BASE`、`API_BASE`、`SMOKE_USER`。

带 `SMOKE_GENERATE=1` 时会额外跑一遍真实的 AI 生成（真实消耗模型 token 与高德配额），
完整验证「点击生成 → 轮询进度 → 已生成」这条链路。

### 开发期排查脚本

这几个脚本都可在**项目根目录**直接执行，不必手动 `cd` 到 `apps/server`：

```bash
# 手动跑一次真实生成，终端会打印每一次工具调用与每天的产出
# 末尾可加 restart 验证清空重排
npm run try:generate -- <用户名> <天数> [restart]

# 单独验证某个账号的模型凭据是否可用（只输出掩码，不打印明文 Key）
npm run check:credential -- <用户名>

# 解析器自检：把「模型输出 JSON 说毛边」的各种形态固化成用例
npm run check:parser

# 排程规则自检：景点上限、餐厅不连排、跨天去重、编造地点被丢弃
npm run check:scheduler
```

> 模型偶尔会输出无法直接解析的 JSON。实测见过这些形态：前后夹解释文字、
> 字符串里有裸换行、写到一半撞上长度上限被截断、**数字值后面凭空多一个引号**。
> 最后一种最阴险：一个多余字符会让其后所有引号的配对整体错位，整段 JSON 报废，
> 而且报错位置可能离真正出错的地方很远。

防线分四层，前两层在解析器里（`services/agent/scheduler.ts` 的 `parsePlanJson`）：

| 层 | 做什么 |
|---|---|
| ① 解析器阶梯 | 依次尝试：原样 → 修裸换行/尾逗号 → **按解析器反馈逐处修复结构** → 补全截断 → 全角逗号归一。每级都用 `JSON.parse` 验收 |
| ② 结构定点修复 | 借 `JSON.parse` 的报错下标当探针，只在该位置判断：引号后跟冒号＝漏了逗号（补），否则＝多余的引号（删）。反复迭代，一处六处都能修 |
| ③ 让模型重说 | 仍失败则带着**出错位置附近的原文片段**请模型重新输出一次（不重跑工具查询，成本仅一次对话） |
| ④ 存档 + 可读报错 | 两次都失败才报错，并把模型原始输出存到 `apps/server/.debug/`（已 gitignore）供事后排查 |

另外两处预防性设计：

- **显式指定 `max_tokens` 与 `temperature`**，不落到厂商默认值上。DeepSeek 默认输出上限 4096、
  温度 1.0 —— 前者会让长行程被截断，后者会让「多吐一个字符」这类毛刺更容易被采样出来。
  可用 `MODEL_MAX_OUTPUT_TOKENS` 覆盖上限。
- **不要求模型输出 `dayIndex`**。第几天按 `days` 数组顺序判定，服务端自己编号。
  实测故障恰好都出在 `"dayIndex":N` 这个位置上，少一个字段就少一处出错机会。

`npm run check:parser` 把这 14 种形态都固化成了用例，其中 4 条直接来自真实故障存档。

## 环境变量

所有密钥均通过环境变量注入，**代码中不出现任何密钥**。参见 `apps/server/.env.example`。

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 数据库连接串，开发期为本地 SQLite 文件 |
| `PORT` | 后端监听端口，默认 3001 |
| `JWT_SECRET` | JWT 签名密钥，需自行生成一串足够随机的字符 |
| `VAULT_MASTER_KEY` | 用户 API Key 的加密主密钥（32 字节，hex 编码） |
| `AMAP_WEB_SERVICE_KEY` | 高德 Web 服务 Key，**仅后端使用，绝不下发前端** |
| `AMAP_JS_KEY` | 高德 Web 端（JS API）Key，由后端下发给浏览器加载地图 |
| `AMAP_JS_SECURITY_CODE` | 高德 JS API 安全密钥，与 JS Key 配套 |
| `DEFAULT_MODEL_PROVIDER` | 兜底模型厂商名，仅当用户未配置自己的 Key 时生效 |
| `DEFAULT_MODEL_BASE_URL` | 兜底模型接口地址（OpenAI 兼容），如 `https://api.deepseek.com/v1` |
| `DEFAULT_MODEL_NAME` | 兜底模型名，如 `deepseek-chat` |
| `DEFAULT_MODEL_API_KEY` | 兜底模型 Key。**填了它，所有未配置 Key 的账号都会消耗这个 Key 的余额**，生产环境请留空 |
| `MODEL_MAX_OUTPUT_TOKENS` | 模型单次输出上限，默认 8192。调小可降低长行程被截断的风险 |
| `PARALLEL_CANDIDATES` | 「并行择优」每天生成的候选方案数，默认 1（即不并行） |

> 高德开放平台需要分别申请「Web 服务」与「Web 端(JS API)」两种类型的 Key，二者用途不同、不可混用。
> 所有高德配置**只维护 `apps/server/.env` 这一份**，前端不单独存放，避免出现两处不一致。

### 安全提醒

- **Web 服务 Key 等同于钱**（被盗刷会直接产生费用）。除了不提交到仓库，建议在高德控制台为该 Key 配置 **IP 白名单**，只允许你自己的服务器出口 IP。
- **JS API Key** 会出现在浏览器里，这是它的设计使然；保护手段是在控制台配置 **域名白名单**，只在你的域名下生效。
- 提交前可自查是否有密钥混入：

  ```bash
  git grep -nE "(AMAP_[A-Z_]*KEY|VAULT_MASTER_KEY|JWT_SECRET)\s*=\s*[\"']?[0-9a-zA-Z]{16,}" -- . ':!*.example' || echo "未发现硬编码密钥"
  ```

## 数据来源与合规说明

- 地图与 POI 数据均来自**高德开放平台官方 API**，遵守其服务条款。
- 本项目**不抓取小红书、美团、大众点评等平台的内容**。这些平台或未开放第三方内容检索接口，或仅面向具备企业资质的服务商，非公开渠道抓取存在法律与封禁风险。
- 境内地图展示使用具备测绘资质的地图服务，不自行绘制或修改国界线与行政区域。
- 行程内容由大语言模型生成，**营业时间、价格、开放状态请以实际情况为准**。

## 许可

个人学习与实践项目。
