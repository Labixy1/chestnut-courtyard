# 栗壳小院架构

## 请求链路

`Global Butler UI -> event ledger -> preference observation -> memory context assembly -> fast router or AI planner -> validated tool -> persistence -> verification/task/audit`

明确命令优先走确定性快速路由，避免状态检查、周报刷新、链接解析、归档和待读等操作浪费一次模型规划。模糊或多步请求才交给本机 Codex / OpenAI Responses API，模型只产生工具计划，不能绕过工具宣称成功。

## 运行层

- `index.html` 与 `pages/`：原生静态界面。
- `core/data.js`：`file://` 离线数据桥，确保双击首页可浏览。
- `core/butler_widget.js`：全局阿栗入口、任务状态、跨页数据同步。联网时服务端状态为权威副本，防止已删数据被旧 localStorage 复活。
- `scripts/cozy_server.py`：静态服务、AI 调用、网页解析、房间对话、照片上传、每日题和健康检查。
- `scripts/butler_tools.py`：快速路由、Agent 工具计划、参数验证和内容操作。
- `scripts/system_runtime.py`：掌院权限、任务卷宗、快照、回滚、系统修改和动态 Skill。
- `scripts/memory_store.py`：事件、工作记忆、偏好档案、短期、长期、封存、晋升、转层、忘记与 tombstone。
- `scripts/memory_distiller.py`：非封存记忆的 AI 语义合并、冲突提案、自然档案重写、结构校验、差异记录和回滚。
- `scripts/automation_runner.py`：每小时检查记忆保留期和本周周报。
- `scripts/butler_weekly.py`：真实信息源抓取、去重、重要性排序、栏目组织和可选的批量 AI 精炼。
- `scripts/model_gateway.py`：统一 DeepSeek、GLM、Qwen、OpenAI、Seedream 和 Seedance 协议，密钥只读环境变量。
- `scripts/media_service.py`：图片落盘、Seedance 异步任务状态和生成文件持久化。
- `scripts/event_ledger.py` / `logger.js`：与记忆分离的 append-only 操作流水，默认不记录留言正文。
- `scripts/run_skill.py`：点火式 CLI，一次执行一个已注册工具后退出。
- `cloudflare/worker.js`：云端同源 API、Cloudflare Access 校验、KV 任务状态及 R2 日志/媒体存储。
- `scripts/build_cloud.py`：生成排除树洞、密阁和运行数据的 `dist/` Pages 发布包。

## 双运行时

- 本地运行时是完整掌院环境：Python 服务、本机 Codex、文件快照、动态 Skill、语音和全部房间数据。
- 云端运行时是主人专用的轻量环境：Pages + Worker + 外部模型 API。它不能直接修改本机系统文件。
- `file://` 仍回退 `core/data.js`；HTTP/HTTPS 页面统一调用同源 `/api/*`。
- GitHub 只保存程序和公开场景素材。密钥放 Cloudflare Secret，事件和生成文件放私有 R2，运行状态放 KV。

## API

GET：

- `/api/status`：AI 连接、工具数量和掌院权限。
- `/api/providers`：文本、图片和视频供应商的配置状态及模型 ID，不返回密钥。
- `/api/media/tasks`：生成任务列表或单个任务状态。
- `/api/health`：必要文件、JSON、AI、周报和权限健康状态。
- `/api/blackboard/today`：读取或生成当日题。
- `/api/state` / `/api/local-state`：阿栗内容状态和跨页界面状态。
- `/api/permissions` / `/api/memory` / `/api/tasks` / `/api/skills` / `/api/automation`：密阁系统面板数据。

POST：

- `/api/assistant`：全局阿栗 Agent。
- `/api/room`：果园、树洞、黑板和旅行专用对话。
- `/api/parse`：抓取、AI 摘要、分类并归档网页。
- `/api/media/upload`：照片墙、旅行照片和树洞埋藏影像。
- `/api/media/generate`：调用 Seedream、GPT Image 或 Seedance；视频返回可持续查询的任务。
- `/api/media/task/refresh`：刷新 Seedance 状态，成功后保存视频。
- `/api/events`：批量写入独立的 append-only 事件 ledger。
- `/api/weekly/run`：立即生成或确认本周周报。
- `/api/state/sync` / `/api/local-state`：持久化内容状态和界面状态。
- `/api/permissions`：开关掌院权限。
- `/api/memory/event` / `/api/memory/sync` / `/api/memory/action`：写入、同步、转层和彻底忘记。
- `/api/tasks/undo`：恢复系统快照。
- `/api/voice/start` / `/api/voice/stop`：macOS 本机语音识别，树洞使用；公告板语音按主人要求暂时禁用。

## 权限与安全

普通工具只改内容数据。系统文件、Prompt、记忆结构或 Skill 的修改必须通过掌院权限。`run_system_change` 固定流程为：

1. 校验掌院权限。
2. 创建项目文本快照。
3. 调用 workspace-write Codex 实施明确任务。
4. 运行必要验证。
5. 写入任务卷宗和审计日志，保留快照 id 用于撤销。

服务启动时会将上次进程留下的 `running` 任务标为已中断，避免卷宗永久显示进行中。

## 记忆政策

记忆不是一份聊天记录，而是六个职责不同的层：

1. **原始事件**：保留时间、来源、类型、内容、摘要、权重与敏感级别，作为可追溯证据。
2. **工作记忆**：保存最近任务和当前上下文，默认随短期保留期衰减。
3. **偏好档案**：保存偏好陈述、作用域、来源证据、置信度和状态。明确表达可直接确认；单次行为只做候选，重复证据达到阈值才确认。
4. **短期记忆**：最近三十天的任务、困惑和行为线索；跨日重复可晋升。
5. **长期记忆**：主人明确要求记住的事实，或经过多次证据确认的稳定模式。
6. **封存记忆**：树洞、密阁和最高级秘密，普通上下文永不读取原文。

每次阿栗规划、房间对话和掌院系统修改前，`prompt_context()` 只装配相关的已确认偏好、非封存记忆摘要和最近工作上下文。当前明确要求始终高于旧偏好；候选偏好不作为强约束。忘记操作会删除各层副本并记录 tombstone，防止旧客户端把内容重新同步回来。

AI 蒸馏不直接写模型自由文本。模型必须返回包含合并组、冲突关系、候选建议和档案章节的 JSON；本地引擎验证引用 id、证据阈值、分类、档案覆盖率和封存泄漏后，才一次性更新卡片与档案。每次运行写入 `core/memory/distillations/`，保留整理前卡片、前后档案和差异，可恢复。失败时不会改变原数据，确定性 `_refresh_profile()` 仍是兜底。

## Skill

随框架发布的内置 Skill 放在 `core/skills/<name>/SKILL.md`。实例中新增的私有 Skill 放在被 Git 忽略的 `core/private_skills/`。可执行 Skill 还需要 `tool.json` 和 `scripts/run.py`：从 stdin 读取 JSON，向 stdout 返回带 `ok` 和 `summary` 的 JSON。缺失能力时，阿栗在掌院权限下可创建、测试并注册私有 Skill。

`python3 scripts/skill_validation.py` 会在临时目录中逐项验证全部固定 Skill、注册工具路由和动态 Skill 样例，不触碰主人数据；结果写入 `core/skill_health.json`。

图片与视频使用 `generate_media` / `check_media_task` 两个工具。媒体 Skill 只在主人明确要求生成时调用，视频提交成功不等于生成完成。CLI 示例：

```bash
python3 scripts/run_skill.py generate_media --json '{"kind":"image","provider":"seedream","prompt":"清晨的小院"}'
```

## 自动运行

`scripts/install_autostart.py` 安装 macOS LaunchAgent `com.cozy-estate.butler`，监听 `127.0.0.1:8766`。日志位于 `core/logs/`。自动任务幂等：已有本周周报时不覆盖，同一周手动刷新时按周 id 更新，历史周不受影响。记忆蒸馏每天 23:30 检查一次，或累计至少 4 张变化卡片后在后台运行；普通请求不等待蒸馏完成。

云端记忆蒸馏仍保持关闭；当前蒸馏只在本地完整运行时执行，直到云端封存边界与数据范围通过单独审查。
