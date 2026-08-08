# AGENTS.md — Cozy Estate 开发手册（Codex 请先读这份）

> 这是一个**本地优先、静态界面 + 可选本地服务**的个人小院，只服务作者一个人。
> 目标是两周 MVP，先能跑、氛围对，不追求工程完美。
> 当前仓库已有一版**可运行的视觉预览**（全部 CSS/SVG 手绘占位），你的任务是在此基础上继续，而**不是推翻重写**。

---

## 0. 铁律（违反即算失败）

1. ❌ 不要引入 Next.js / Vite / React 构建 / Docker / 数据库 / 登录 / 鉴权 / npm install。
2. ✅ 只用原生 HTML + CSS + ES6 JS。可选 CDN 引入 Vue/Svelte，但**不准装依赖**。
3. ✅ 所有持久数据存 `core/` 下的 JSON；图片存 `assets/`，用 `manifest.json` 索引。
4. ✅ 归档脚本用 **Python 标准库**（不装包），不要用 Node。
5. ✅ **双击 `index.html`（file://）必须能跑**。这是硬指标，见第 3 节。
6. ✅ AI 能力由 `scripts/cozy_server.py` 调用本机 Codex，或在设置 `OPENAI_API_KEY` 后调用 Responses API；前端不得保存密钥。
7. ✅ 树洞与密阁是封存区：普通权限永不读取原文；掌院权限开启后，也只有主人明确要求时才能按任务最小范围读取。
8. ✅ 系统修改必须经过掌院权限、快照、验证和审计；普通内容操作不需要掌院权限。

---

## 1. 目录结构（已建好，保持）

```
cozy-estate/
├── index.html            # 庄园主屏（双击入口）
├── pages/
│   ├── bedroom.html      # 卧室（瓢虫爬行、拉绳灯、布娃娃）
│   ├── heart_hollow.html # 情绪树洞（日记本左右页 + 月份索引 + 语音口述）
│   ├── private_wing.html # 私人密室（铜牌墙 + 玻璃匣 + 牛皮日记）
│   └── travel.html       # 旅行页（拍立得 + 出发动画）
├── core/
│   ├── user_profile.yaml # 庄园性格配置（管家读它）
│   ├── estate_state.json # XP/连击/外墙照片/旅行历史
│   ├── manifest.json     # 黑板/工具箱/知识素材索引
│   ├── heart_hollow.json # 树洞记录（独立）
│   ├── private_wing.json # 密室铜牌/年度一句话/日记（独立）
│   ├── data.js           # 上述 JSON 的镜像，供 file:// 读取（ingest 自动重建）
│   ├── defaults/         # 可公开的空白实例种子；新下载副本据此初始化
│   ├── runtime-config.js # owner/selfhost/interview/preview/dev 模式配置
│   ├── runtime.js        # 统一数据适配与写入能力边界
│   ├── memory/           # 证据流水 / 记忆卡片 / 动态分类 / 封存密库
│   ├── skills/           # 随框架发布的内置 Skill
│   ├── private_skills/   # 当前实例新建的私有 Skill；永不进入 Git
│   ├── permissions.json  # 永久掌院权限开关
│   ├── tasks.json        # Agent 与系统修改任务卷宗
│   ├── audit_log.json    # 权限、快照、Skill 执行审计
│   └── prompts/          # 分角色提示词
├── assets/               # blackboard cards news plants toolbox travel photos interior estate
├── scripts/cozy_server.py # 本地 API / AI / 房间对话
├── scripts/model_gateway.py # 文本/图片/视频供应商协议
├── scripts/media_service.py # 生成任务与文件持久化
├── scripts/event_ledger.py # 与记忆分离的 append-only 流水
├── scripts/run_skill.py # 点火式 Skill CLI
├── scripts/butler_tools.py # Agent 工具路由
├── scripts/system_runtime.py # 权限 / 快照 / 回滚 / 动态 Skill
├── scripts/memory_store.py # 证据驱动的记忆卡片与任务上下文
├── scripts/memory_distiller.py # AI 语义蒸馏、结构校验、差异与回滚
├── scripts/automation_runner.py # 周报与记忆维护
├── scripts/ingest.py     # 手动归档（photo/travel/blackboard/toolbox…）
├── inbox/                # 待归档图片临时目录
└── README.md
```

---

## 2. 已完成 vs 待办

### ✅ 已完成（可运行，勿推翻）
- 主屏 CSS 手绘全景 + 7 个热点（公告板/黑板/老树/书房古树/树桩/果园/小屋/行李箱）跳转与弹层。
- 外墙照片墙：读 `estate_state.wall_photos[]`，百分比定位 + 随机 rotate + hover 放大 + 点击 200px 预览，最多 15 张，缺图有 emoji 兜底。
- 卧室：布娃娃、被子、拉绳灯（可开关）、瓢虫 CSS 沿墙爬行动画。
- 树洞：日记本左右页、月份索引、上一页/下一页、打字 + `SpeechRecognition` 口述、树回响用本地句库占位。
- 密室：铜牌墙 / 玻璃匣（含封存日期）/ 牛皮日记渲染。
- 旅行：拍立得墙 + 出发 fade 占位。
- `ingest.py`：移动图片 → 更新 JSON → 重建 `data.js`。已测通。

### ✅ 当前 Agent 架构
- `start.command` 启动本地服务后，全局阿栗可在每个页面执行任务。
- 普通工具负责公告板、栗夹、信息源、工具箱、分类与记忆操作。
- 密阁“掌院权限”永久保存；开启后可修改项目、Prompt、Skill 和记忆结构。
- 每次系统修改自动创建 `core/snapshots/` 快照，结果写入任务卷宗和审计日志。
- 缺少能力时，阿栗可在 `core/private_skills/` 创建带 `SKILL.md`、`tool.json`、`scripts/run.py` 的实例私有 Skill，测试后注册。
- 周报按周永久归档并可完整展开；后台自动检查本周周报与候选记忆。

---

## 3. file:// 关键约定（最容易踩坑，务必遵守）

浏览器在 `file://` 下**禁止 `fetch()` 读本地 JSON**（CORS）。因此：

- 每个页面先加载 `runtime-config.js` 和 `runtime.js`，再通过 `CozyRuntime.loadJson()` 读取数据；它会在本地 HTTP 下读取实例 JSON，在 `file://` 或预览模式下回退 `window.COZY`。
- 任何修改 `core/*.json` 的脚本，结束时**必须调用 `ingest.rebuild_data_js()`** 重建 `data.js`，否则双击打开看到的是旧数据。
- 新增页面时，路径注意：根目录用 `core/`、`assets/`；`pages/` 下用 `../core/`、`../assets/`。

### GitHub 隐私边界

- Git 只追踪程序、公开素材、内置 Skill 和 `core/defaults/instance_seed.json`。
- 真实实例 JSON、`core/memory/`、`core/private_skills/`、运行日志、上传照片、`.env`、`.wrangler/` 和 `dist/` 必须保持忽略。
- 发布或提交前运行 `python3 scripts/privacy_scan.py`；公开构建只能读取空白种子，不能读取当前实例数据。
- 不要用 `git add -f` 绕过忽略规则，也不要把真实 API Key 写进前端或仓库历史。

---

## 4. 数据结构速查

```jsonc
// estate_state.json
{ "xp":120,"streak":3,"level":"园丁学徒",
  "travel":{"history":[{"id","place","date","line","file"}]},
  "wall_photos":[{"id","type":"travel|life","file","date","note","position":{"x","y","rotate"}}] }

// heart_hollow.json
{ "entries":[{"date","time","transcript","echo","weather"}], "settings":{} }

// private_wing.json
{ "plates":[{"id","kind":"思维习惯|情绪模式","content","source","date"}],
  "diary":[{"date","content"}], "glass_case":{"content","next_modifiable"} }

// manifest.json
{ "items":[{"id","type":"blackboard|toolbox|card|plant|news","title","file",...}] }
```

铜牌规则：树洞每累积 7 条记录 → 分析师（`tree_analyst.txt`）铸 1 块铜牌，`source:"heart_hollow_analysis"` 写入 `private_wing.plates`。

记忆规则：所有行为先写 `core/memory/events.json` 作为证据；结论写入 `cards.json`，并自动汇总为 `profile.json` 文本档案。主人明确要求记住时卡片立即生效，推断卡片保持候选，重复证据达到阈值后才生效。基础分类保持稳定；主人可直接新建分类，系统推断的新分类至少由 3 张相关卡片支持后才自动启用，并允许改名、移动、合并和删除。每次任务只注入相关的生效卡片，当前要求始终优先；不要把整篇展示档案无差别注入任务。树洞、密阁和最高级秘密只进 `sealed.json`，不得复制到普通卡片、文本档案或普通上下文。

AI 蒸馏只读取非封存卡片，模型输出必须先经过本地结构、引用、阈值与隐私校验。蒸馏失败时保留原卡片和规则档案；成功记录前后档案、差异和可回滚数据。不得将封存内容加入蒸馏提示词。

`short_term.json`、`long_term.json` 和 `preferences.json` 目前是兼容视图，不是新的事实来源；不要绕过 `MemoryStore` 直接写它们。

---

## 5. 视觉基调（生成图 / 新增 UI 都遵循）

Tiny Glade / cottagecore / 手账风 / 钝感温柔 / 水彩 / 暖而低饱和 / 无人物 / 无文字。
Seedream 前缀：`Tiny Glade style, isometric cottagecore, soft watercolor, 3d render, warm muted palette, no people, cozy`。

---

## 6. 交付验收（每次改完自检）

- [ ] 双击 `index.html`（file://）能看到墙上有 tiny 照片、点树进日记本、点屋进卧室。
- [ ] `python3 scripts/ingest.py inbox/x.jpg --type photo --note "…"` 后刷新，外墙多一张。
- [ ] 改过 `core/*.json` 后 `data.js` 已同步。
- [ ] 没有引入构建工具、npm 依赖、数据库或远程业务后端；本地服务只用 Python 标准库。
- [ ] `python3 scripts/system_smoke_test.py`、`node scripts/notice_smoke_test.js` 和 `node scripts/html_syntax_test.js` 通过。
- [ ] `python3 scripts/model_gateway_test.py` 和 `python3 scripts/skill_validation.py` 通过；测试不得调用付费生成接口。
- [ ] 掌院权限关闭时系统修改被拒绝，开启后修改有快照和卷宗。
