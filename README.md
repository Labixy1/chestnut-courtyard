# 栗壳小院

一个只服务主人的本地优先个人系统。页面保持纯静态，本地 Python 服务让阿栗能够真正解析网页、调用 AI、写入记忆、生成周报和执行系统任务。

## 分发模式

同一套代码支持五种运行模式：`dev` 用于本机调试，`owner` 是主人的私人云端实例，`selfhost` 是下载者自己的实例，`interview` 是限时体验空间，`preview` 是公开只读预览。模式由 `core/runtime-config.js` 注入，页面统一通过 `core/runtime.js` 选择数据来源和写入能力。

GitHub 只保存程序、公开素材、内置 Skill 和 `core/defaults/instance_seed.json`。真实周报、记忆、树洞、密阁、照片、权限、任务、运行日志、实例私有 Skill 和 API Key 都被 `.gitignore` 排除。新下载的副本首次启动时，`scripts/instance_data.py` 会从公开种子创建一套空白私人实例，不会连接原作者的数据。

发布前运行：

```bash
python3 scripts/privacy_scan.py
python3 scripts/repository_readiness_test.py
python3 scripts/build_cloud.py --mode preview
python3 scripts/cloud_privacy_test.py
python3 scripts/build_cloud.py --mode owner
python3 scripts/cloud_owner_test.py
node scripts/cloud_worker_test.mjs
```

公开预览构建只读取公开种子，不读取当前实例的 `core/*.json`。PWA 文件 `manifest.webmanifest` 和 `sw.js` 允许通过浏览器把小院安装成独立应用。

## 直接使用

- 完整模式：双击 `start.command`，打开 `http://127.0.0.1:8766/index.html`。
- 主院会根据自动识别到的当地天气与时间切换晴天、清晨、雨、雪、阴天和雾景；天气每 2 小时更新一次，断网时回退最近结果或晴天。
- 自动启动：双击 `install-autostart.command`，以后登录 Mac 后阿栗会自动运行。
- 离线浏览：直接双击 `index.html`。`file://` 模式可浏览现有场景和数据，AI、上传和跨页同步需要本地服务。

阿栗会出现在每个页面左上角。明确命令如状态检查、巡报刷新、网页解析、归档和待读会直接调用工具；需要理解、规划或内容生成的任务才会交给主人配置的文本模型 API。

## 模型与媒体 API

复制 `.env.example` 为被 Git 忽略的 `.env` 并填入至少一个文本模型密钥；本地服务启动时会自动读取，不要把真实密钥写进其他项目文件。支持：

- 文本：OpenAI、DeepSeek、GLM、Qwen。
- 图片：Seedream 和 GPT Image，默认模型名分别为 `doubao-seedream-5-0-pro-260628` 与 `gpt-image-2`。
- 视频：Seedance，使用持久化异步任务，离开页面后仍可继续查询。

Seedream 与 Seedance 共用 `ARK_API_KEY`。实际账号开放的模型 ID 不同时，只需修改对应 `COZY_*_MODEL` 环境变量。

## 小院房间

- 公告板：每周一、周三、周六 08:00 自动巡逻国内外 AI 与产品资讯，生成新的资讯巡报；保留原摘要、AI 精炼、原文、待读和栗夹归档，往期巡报默认收起、可完整展开。
- 黑板：每日一道产品问答题，可结合近期资讯、果园线索、历史答案和出题方向留言；提交后由 AI 返回逐点诊断、润色答案、标准要点、修改建议和下一题。
- 工具箱：按使用场景分类，阿栗可新增、更新、移动或删除工具。
- 智慧果园：围绕成长、方向和困惑交流，再沉淀为成长种子和收成。
- 树洞：语音优先，文字入口较轻。一天可多次记录，原文只进封存记忆。草坪连续点击五次可打开历史和埋下的影像。
- 照片墙：普通上传与旅行照片按照片集管理，可新增、删除、移动并按时间排序；不读取树洞封存影像。
- 出发旅行：按地点组织出发日期、回家日期、两三张照片和可编辑的旅行感悟。
- 卧室与密阁：卧室三处灯光热区可开关灯。书墙连续点击三次打开密阁，按分类查看记忆卡片、候选卡片、封存密库、任务卷宗、Skill 和掌院权限。

## 权限与记忆

掌院权限保存在 `core/permissions.json`。主人在密阁开启后永久生效。系统修改由主人配置的文本模型 API 驱动，代理只能搜索、读取和精确修改项目内文本文件；执行前创建 `core/snapshots/` 快照，完成后自动验证，失败自动回滚，并写入 `core/tasks.json` 和 `core/audit_log.json`。

记忆由四部分组成：不可变的证据流水、可管理的记忆卡片、每次任务临时组装的上下文包，以及独立封存密库。密阁默认把生效卡片自动汇总为一份连贯的“我的记忆档案”，卡片变化后自动重写；候选和封存原文不会进入档案。明确要求记住会立即激活卡片；单次推断只成为候选，重复证据达到阈值后才生效。卡片有稳定基础分类，也支持主人新建和系统按证据自动形成分类，并可改名、移动、合并或删除。阿栗只把与当前任务相关的生效卡片放进上下文，当前要求始终优先。树洞、密阁和最高级秘密只进封存密库；掌院权限开启后，也只有主人明确要求时才按最小范围读取。彻底忘记会留下本地 tombstone，防止旧副本把它复活。

AI 记忆蒸馏在后台读取非封存卡片，合并语义重复、识别有证据支持的冲突，并把已生效记忆改写成自然档案。模型只返回结构化提案；本地会再次校验卡片 id、晋升阈值、分类、档案引用和封存边界，整次校验通过后才原子写入。每次成功保留前后档案、差异和回滚数据。没有模型或模型输出无效时，原有确定性档案继续可用。

## 常用命令

```bash
# 启动本地服务
python3 scripts/cozy_server.py --port 8766

# 验证全部固定和动态 Skill（不会修改主人数据）
python3 scripts/skill_validation.py

# 验证模型协议，不调用真实付费 API
python3 scripts/model_gateway_test.py
python3 scripts/memory_distillation_test.py

# 查看或直接执行一个 Skill 工具
python3 scripts/run_skill.py --list

# 立即生成一份资讯巡报
python3 scripts/butler_weekly.py

# 只对已有巡报做 AI 精炼，不重新抓取
python3 scripts/butler_weekly.py --refine-existing

# 手动归档照片
python3 scripts/ingest.py inbox/tea.jpg --type photo --note "晚上的茶"

# 完整验收
python3 -m py_compile scripts/*.py
python3 scripts/system_smoke_test.py
python3 scripts/service_smoke_test.py
```

## Cloudflare

`python3 scripts/build_cloud.py --mode preview` 生成公开只读的 `dist/`；`--mode owner` 生成主人专用的 `dist-owner/`。主人版由同源 Worker 提供口令登录、KV 私人状态、阿栗对话、网页解析和非封存记忆档案，口令与模型密钥只存 Cloudflare Secret。公开构建和主人构建都只携带空白种子，树洞、密阁、运行日志和 API Key 不进入 GitHub。R2 尚未在当前 Cloudflare 账户启用，因此云端照片上传与生成媒体持久化暂时关闭；本地完整版本不受影响。

## 数据位置

- `core/estate_state.json`：照片墙、旅行基础记录和小院状态。
- `core/local_state.json`：浏览器交互在本地服务中的跨页副本。
- `core/notice_reports.json` / `core/butler_state.json`：资讯巡报和公告板归档。
- `core/daily_questions.json`：每日黑板题。
- `core/memory/`：证据流水、记忆卡片、分类、兼容视图与封存密库。
- `core/skills/`：随框架发布的内置 Skill。
- `core/private_skills/`：阿栗在当前实例中新建的私有 Skill，不进入 GitHub。
- `core/data.js`：供 `file://` 读取的 JSON 镜像，由脚本自动重建。

手动修改 `core/*.json` 后，运行 `python3 -c "from scripts import ingest; ingest.rebuild_data_js()"` 同步离线镜像。

## 运行要求

项目不使用 npm、前端框架、数据库或 Docker。本地完整版本只需要现代浏览器、Python 3，以及至少一个主人自己的文本模型 API；主人云端版本使用无依赖 Worker、KV 和 HttpOnly 口令会话，也可配置 OpenAI、DeepSeek、GLM、Qwen、Seedream 与 Seedance。
