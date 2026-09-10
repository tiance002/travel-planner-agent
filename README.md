# Travel Planner Agent

一个基于 AI Agent 的旅游规划 Web 应用。用户提交目的地、日期、天数、人数、偏好与预算后，系统以**住宿地点为锚点**，结合高德地图 POI 数据与实时天气，生成按天编排的行程，并在地图上展示路线、支持到点打卡。

> 项目当前处于开发阶段，功能随迭代逐步开放。

## 核心特性（规划中）

- **账号体系**：用户名 + 密码注册登录，JWT 会话
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
| 地图与 POI | 高德开放平台 Web 服务 API（POI 搜索 / 路径规划 / 天气） |
| 长周期天气 | Open-Meteo（补高德 4 天预报上限） |

### 关于 Prisma 7 的两个注意点

Prisma 7 有两处与网上多数教程不同的破坏性变更，改动是刻意为之，不是配置错误：

1. **连接串不再写在 `schema.prisma` 里**，而是移到 `apps/server/prisma.config.ts` 的 `datasource.url`；`schema.prisma` 的 `datasource` 块只声明 `provider`。
2. **客户端必须显式传入 driver adapter**。项目选用 `@prisma/adapter-libsql`，原因是它依赖平台预编译包，无需 node-gyp 本地编译；而 `better-sqlite3` 需要执行安装脚本（`prebuild-install || node-gyp rebuild`），在 Windows 上更容易失败。

另外，生成的客户端代码位于 `apps/server/src/generated/prisma/`，属于构建产物，已在 `.gitignore` 中排除，需要执行 `prisma generate` 重新产出。

## 目录结构

```
.
├─ apps/
│  ├─ web/                      # 前端应用
│  └─ server/                   # 后端服务
├─ docs/                        # 设计与方案文档
├─ package.json                 # npm workspaces 根配置
└─ .env.example                 # 环境变量模板
```

## 本地启动

前置要求：Node.js 20 及以上。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp apps/server/.env.example apps/server/.env
# 然后编辑 apps/server/.env，填入你自己生成的密钥
#
# 生成两个密钥的命令：
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # VAULT_MASTER_KEY

# 3. 初始化数据库（会自动生成 Prisma 客户端并创建 apps/server/prisma/dev.db）
npm run db:migrate

# 4. 同时启动前后端
npm run dev
```

启动后：前端 http://localhost:5173 ，后端 http://localhost:3001 。

> 首次运行 `npm run db:migrate` 需要联网下载 Prisma 的 schema engine，耗时取决于网络状况。

## 环境变量

所有密钥均通过环境变量注入，**代码中不出现任何密钥**。参见 `apps/server/.env.example`。

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 数据库连接串，开发期为本地 SQLite 文件 |
| `JWT_SECRET` | JWT 签名密钥，需自行生成一串足够随机的字符 |
| `VAULT_MASTER_KEY` | 用户 API Key 的加密主密钥（32 字节，hex 编码） |
| `AMAP_WEB_SERVICE_KEY` | 高德 Web 服务 Key，仅后端使用，不下发前端 |
| `AMAP_JS_KEY` | 高德 Web 端（JS API）Key，用于浏览器加载地图 |
| `PORT` | 后端监听端口，默认 3001 |

> 高德开放平台需要分别申请「Web 服务」与「Web 端(JS API)」两种类型的 Key，二者用途不同、不可混用。

## 数据来源与合规说明

- 地图与 POI 数据均来自**高德开放平台官方 API**，遵守其服务条款。
- 本项目**不抓取小红书、美团、大众点评等平台的内容**。这些平台或未开放第三方内容检索接口，或仅面向具备企业资质的服务商，非公开渠道抓取存在法律与封禁风险。
- 境内地图展示使用具备测绘资质的地图服务，不自行绘制或修改国界线与行政区域。
- 行程内容由大语言模型生成，**营业时间、价格、开放状态请以实际情况为准**。

## 许可

个人学习与实践项目。
