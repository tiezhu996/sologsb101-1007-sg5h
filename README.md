# 尾矿库坝体位移与浸润线监测台（sologsb101-1007）

面向尾矿库安全监测与库区安全管理岗位，按坝体断面布设表面位移、测斜、浸润线与渗压测点，逐次录入观测值并对超阈值测点触发预警与处置跟踪。核心动作：建坝与断面、布测点配阈值、录观测值、算累计位移与日速率、触发预警闭环、记录库水位与干滩长度。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22807**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Ant Design 5 | 表格、表单、Modal、Drawer、Tag、Descriptions |
| 状态管理 | Zustand 4.5 | `damStore` / `pointStore` / `alarmStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1007/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtaildam
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # dam.ts section.ts point.ts observation.ts alarm.ts correction.ts pool.ts
        ├── stores/             # damStore.ts pointStore.ts alarmStore.ts correctionStore.ts
        ├── components/common/  # AlarmTag.tsx CorrectionModal.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useAlarmLevel.ts useIdbTable.ts
        ├── pages/              # DamList.tsx PointConfig.tsx ObservationEntry.tsx TrendBoard.tsx AlarmBoard.tsx CorrectionList.tsx PoolLog.tsx
        ├── router/index.tsx
        ├── utils/              # threshold.ts correction.ts db.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/dams` | 坝体与断面台账 | Dam、Section | 新建/编辑/删除坝体与断面；按坝型、等别筛选；卡片回显测点数与未闭环预警数 |
| `/points` | 测点布设与阈值配置 | Point、Section | 按断面批量布点；逐点改写初值与阈值（草稿 → 逐条/批量提交）；显示最新累计变化与占阈值比 |
| `/observations` | 位移/浸润线观测录入 | Observation、Point | 选定测点按日期录入读数（自动算累计量与日速率）；实时预警级别预览；一键生成预警单；录错读数可发起「订正」留痕 |
| `/trends` | 累计位移与沉降速率计算 | Observation、Point | 按占阈值比降序排行；仅看越限；抽屉查看历次观测序列（订正行显示前值）；按最新观测生成预警单 |
| `/alarms` | 预警触发与处置闭环 | Alarm、Point、Observation | 按级别（红>橙>黄>蓝）排序；状态流转 待处置→处置中→已闭环；填写处置人与措施；订正联动（撤销/读数已订正待重判） |
| `/corrections` | 读数订正记录 | Correction、Observation、Point、Alarm | 列表看订正前/后值、订正人、原因与当日预警联动；同一测点同一天以最后一次订正为准；可只看现行订正 |
| `/pool` | 干滩长度与库水位记录 | Pool、Dam | 按日登记水位/干滩/超高并自动校核；导出 CSV、导出结构版本、重置演示数据 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtaildam`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`dams`、`sections`、`points`、`observations`、`alarms`、`pools`、`corrections`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` 的索引变更与 `upgrade()` 迁移（补齐 `revision`、用所属断面回填测点 `damId`、用测点回填预警 `damId` 并补齐处置字段），以及 `version(3)` 新增 `corrections` 订正记录表、为历史预警补齐 `readingCorrected` / `lastCorrectionId` 字段
- **首屏自动播种**：`initDatabase()` 中 `if (await db.dams.count() === 0) await seedDatabase()`，播种 2 座坝体 → 4 个断面 → 9 个测点 → 21 条观测 → 6 张预警 → 5 条库水位记录的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbtaildam:db-version`、`gbtaildam:last-backup-at`、`gbtaildam:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22807
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 累计变化量 `= 读数 − 初值`；日速率 `= |本次读数 − 上次读数| ÷ 间隔天数`
- 比值 `= |累计变化量| ÷ 阈值`；分级：`≥0.70` 蓝、`≥0.85` 黄、`≥1.00` 橙、`≥1.30` 红
- 干滩长度达标下限 `100 m`，安全超高达标下限 `1.5 m`

## 八、读数订正口径

- 录错读数后在观测录入页点该行「订正」，填写订正后读数、订正人、订正原因；每次订正都写入 `corrections` 留痕
- **同一测点同一天以最后一次订正为准**：观测行读数更新为最新订正值，历史订正留痕全部保留（订正记录页可查前后值、订正人、原因）
- 自订正当日起重算该测点后续累计变化与日速率（整条序列参与计算，仅回写派生值变化的行）；速率排行与观测明细均读订正后的新结果
- 预警联动（按测点 + 触发日期匹配当日预警）：
  - **待处置**：按新值更新级别与触发值；订正后不再越限 → 自动转为**已撤销**（终态，不复活）
  - **处置中**：按新值更新级别与触发值，并标记**读数已订正**，等待人工重判（预警仍成立则清除标记继续处置，否则人工确认撤销）
  - **已闭环**：保留当时级别、触发值与处置内容，不随订正变化
