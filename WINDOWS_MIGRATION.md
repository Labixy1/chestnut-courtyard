# 栗壳小院迁移到 Windows

## 第一次使用

1. 在 Windows 安装 Python 3.11 或更新版本，安装时勾选 **Add Python to PATH**。
2. 解压迁移包到自己的文件夹，不要只复制 `index.html`。
3. 双击 `start-windows.bat`。
4. 等待服务窗口出现后，浏览器会打开 `http://127.0.0.1:8766/index.html`。

项目只使用 Python 标准库，不需要在项目中执行 `pip install` 或 `npm install`。

## 连接 AI

二选一即可：

- 安装并登录 Codex，让 `codex` 命令出现在 PATH 中。这样阿栗可对话；开启掌院权限后还能继续修改系统。
- 设置 `OPENAI_API_KEY`。这样房间对话、知识专题和记忆蒸馏可调用 OpenAI API；系统自修改仍需要 Codex。

可选模型与媒体环境变量：

```bat
setx OPENAI_API_KEY "你的密钥"
setx COZY_OPENAI_MODEL "gpt-5-mini"
setx ARK_API_KEY "你的火山方舟密钥"
```

设置后要关闭并重新双击 `start-windows.bat`。

## 语音

macOS 原生语音组件不会带到 Windows。Windows 会自动改用 Edge/Chrome 的浏览器语音识别；第一次点击麦克风时允许权限即可。建议从 `http://127.0.0.1:8766/` 使用，不要用 `file://` 测试语音。

## 数据位置

- `core/`：记忆、密阁、周报、任务、权限和知识专题等数据。
- `assets/`：小院图片、旅行照片及生成素材。
- `pages/`：房间页面。
- `scripts/`：本地服务、Skill、自动任务和记忆系统。

迁移包包含个人记忆和封存内容，请按私人资料保管，不要上传公共网盘或公开 GitHub。

## 验证

在项目目录打开 PowerShell：

```powershell
py -3 scripts/service_smoke_test.py
py -3 scripts/system_smoke_test.py
py -3 scripts/skill_validation.py
```

三项通过后，公告板、成长田、记忆、Skill 和本地服务的核心流程可用。
