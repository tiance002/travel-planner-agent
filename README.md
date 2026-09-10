# Travel Planner Agent

一个基于 AI Agent 的旅游规划 Web 应用。用户提交目的地、日期、天数、人数、偏好与预算后，系统以**住宿地点为锚点**，结合高德地图 POI 数据与实时天气，生成按天编排的行程，并在地图上展示路线、支持到点打卡。

> 项目当前处于开发阶段，功能随迭代逐步开放。

## 核心特性

- **账号体系**：用户名 + 密码注册登录，JWT 会话，密码以 scrypt 加盐哈希存储
- **四步新建行程**：基本信息 → 内嵌地图选定住宿 → AI 生成 → 结果确认
- **住宿锚点排程**：以住宿为圆心，直线距离排序聚类，高德路径规划生成真实路线与通勤时间
- **智能组合**：每天景点上限 3 个，餐厅就近插入相邻景点之间，不单独占时段
- **营业时间避坑**：结合 POI 营业时间过滤闭馆日
- **地图联动**：按天展示路线，景点标记区分未打卡 / 已打卡状态
- **自带模型密钥**：用户在设置中自行选择模型并填写 API Key，服务端加密托管

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 · TypeScript · Vite 8 · Ant Design 6 · 高德 JS API |
| 后端 | Node.js 22 · Express 5 · TypeScript · Prisma 7 |
| 数据库 | 开发期 SQLite（经 libSQL driver adapter），上线目标 PostgreSQL |
| 数据校验 | Zod 4 |
| AI | CodeBuddy Agent SDK · OpenAI 兼容接口 |
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
| P3 | 模型配置（用户自填 API Key，服务端 AES-256-GCM 加密托管） | ⏳ 待开发 |
| P4 | AI 生成行程（工具调用编排、每日排程规则） | ⏳ 待开发 |
| P5 | 行程详情页（时间轴 + 地图联动 + 到点打卡） | ⏳ 待开发 |

## 后端接口一览

除 `/api/health` 外，所有接口都要求登录，凭证通过 `Authorization: Bearer <token>` 传递。

### 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册，成功后直接返回登录凭证 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 查询当前登录用户 |

### 行程

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/trips` | 当前用户的行程列表 |
| POST | `/api/trips` | 创建行程草稿 |
| GET | `/api/trips/:id` | 行程详情，含每日安排与条目 |
| PATCH | `/api/trips/:id/stay` | 写入或清除住宿锚点 |
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

## 目录结构

```
.
├─ apps/
│  ├─ web/                          # 前端应用
│  │  └─ src/
│  │     ├─ amap/loader.ts          # 高德 JS API 动态加载（含安全密钥设置时机）
│  │     ├─ api/                    # 后端接口调用封装
│  │     ├─ components/AmapMap.tsx  # 地图的 React 封装
│  │     └─ pages/                  # 登录、我的行程、新建行程、个人设置
│  └─ server/                       # 后端服务
│     ├─ prisma/schema.prisma       # 数据模型
│     ├─ prisma.config.ts           # Prisma 7 的连接串配置
│     └─ src/
│        ├─ services/amap.ts        # 高德 Web 服务 API 封装与归一化
│        ├─ services/cache.ts       # 内存 TTL 缓存
│        ├─ routes/                 # 认证 / 行程 / 高德代理路由
│        └─ middleware/auth.ts      # JWT 鉴权
├─ docs/                            # 设计与方案文档
├─ package.json                     # npm workspaces 根配置
└─ apps/server/.env.example         # 环境变量模板
```

## 本地启动

前置要求：Node.js 20 及以上。

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
（默认 `smoke_bot`），可用环境变量覆盖：`CHROME_PATH`、`APP_BASE`、`API_BASE`、`SMOKE_USER`、`SMOKE_PASSWORD`。

## 环境变量

所有密钥均通过环境变量注入，**代码中不出现任何密钥**。参见 `apps/server/.env.example`。

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 数据库连接串，开发期为本地 SQLite 文件 |
| `JWT_SECRET` | JWT 签名密钥，需自行生成一串足够随机的字符 |
| `VAULT_MASTER_KEY` | 用户 API Key 的加密主密钥（32 字节，hex 编码） |
| `AMAP_WEB_SERVICE_KEY` | 高德 Web 服务 Key，**仅后端使用，绝不下发前端** |
| `AMAP_JS_KEY` | 高德 Web 端（JS API）Key，由后端下发给浏览器加载地图 |
| `AMAP_JS_SECURITY_CODE` | 高德 JS API 安全密钥，与 JS Key 配套 |
| `PORT` | 后端监听端口，默认 3001 |

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
