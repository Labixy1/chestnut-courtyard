export const DEFAULT_DATA = Object.freeze({
  estate_state: {xp: 0, streak: 0, level: "新来的住客", travel: {history: []}, wall_photos: []},
  heart_hollow: {entries: [], settings: {}},
  private_wing: {plates: [], diary: [], glass_case: {content: "", next_modifiable: ""}},
  manifest: {items: [
    {id: "tool-openai", type: "toolbox", title: "OpenAI", source: "starter", tags: ["模型", "API"], category: "模型与技术", purpose: "调用文本与多模态模型", url: "https://platform.openai.com/"},
    {id: "tool-codex", type: "toolbox", title: "Codex", source: "starter", tags: ["编程", "Agent"], category: "产品与实践", purpose: "阅读、修改并验证代码项目", url: "https://developers.openai.com/codex/"},
    {id: "tool-figma", type: "toolbox", title: "Figma", source: "starter", tags: ["原型", "设计"], category: "产品与实践", purpose: "设计界面与交互原型", url: "https://www.figma.com/"},
    {id: "tool-deepseek-api", type: "toolbox", title: "DeepSeek API", source: "starter", category: "模型与技术", purpose: "为应用提供中文对话、推理和结构化内容处理能力。", url: "https://platform.deepseek.com/api_keys", source_url: "https://api-docs.deepseek.com/", price_url: "https://api-docs.deepseek.com/quick_start/pricing", pricing: {summary: "按 token 计费；DeepSeek V4 Flash 输出约 $0.28/百万 token 起。", currency: "USD", items: [{label: "V4 Flash 缓存未命中输入", value: "$0.14", unit: "/百万 token"}, {label: "V4 Flash 输出", value: "$0.28", unit: "/百万 token"}, {label: "V4 Pro 输出", value: "$0.87", unit: "/百万 token"}], checked_at: "2026-08-09", source_url: "https://api-docs.deepseek.com/quick_start/pricing", status: "current", note: "官方已提示价格可能调整"}},
    {id: "tool-gemini-nano-banana", type: "toolbox", title: "Gemini API · Nano Banana", source: "starter", category: "图像与视频", purpose: "通过 Gemini API 使用 Google 的原生图片生成与多轮编辑能力。", model: "gemini-2.5-flash-image", url: "https://aistudio.google.com/apikey", source_url: "https://ai.google.dev/gemini-api/docs/image-generation", price_url: "https://ai.google.dev/gemini-api/docs/pricing", pricing: {summary: "Nano Banana 按图像输出 token 计费，1024px 图片约 $0.039/张。", currency: "USD", items: [{label: "1024px 图片", value: "约 $0.039", unit: "/张"}, {label: "图像输出", value: "$30", unit: "/百万 token"}], checked_at: "2026-08-09", source_url: "https://ai.google.dev/gemini-api/docs/pricing", status: "estimate", note: "实际成本随输出规格变化"}},
    {id: "tool-seedream-api", type: "toolbox", title: "Seedream API", source: "starter", category: "图像与视频", purpose: "通过火山方舟生成和编辑高质量场景图、插画和概念视觉。", model: "doubao-seedream-4-0-250828", url: "https://console.volcengine.com/ark/region:cn-beijing/overview", source_url: "https://www.volcengine.com/docs/82379/1824121", price_url: "https://www.volcengine.com/docs/82379/1544106", pricing: {summary: "Seedream 4.0 按成功输出图片数量计费。", currency: "CNY", items: [{label: "输入图", value: "免费", unit: ""}, {label: "输出图", value: "0.20 元", unit: "/张"}], checked_at: "2026-08-09", source_url: "https://www.volcengine.com/docs/82379/1544106", status: "current", note: "组图按实际生成张数计费"}},
    {id: "tool-seedance-api", type: "toolbox", title: "Seedance API", source: "starter", category: "图像与视频", purpose: "通过火山方舟把文字或图片生成具有镜头运动的短视频。", model: "doubao-seedance-2-0-mini-260615", url: "https://console.volcengine.com/ark/region:cn-beijing/overview", source_url: "https://www.volcengine.com/docs/82379/1330310", price_url: "https://www.volcengine.com/docs/82379/1544106", pricing: {summary: "Seedance 2.0 mini 按视频 token 计费，当前活动约 0.2 元/秒起。", currency: "CNY", items: [{label: "无视频输入刊例价", value: "23.00 元", unit: "/百万 token"}, {label: "有视频输入刊例价", value: "14.00 元", unit: "/百万 token"}, {label: "当前活动", value: "4 折，约 0.2 元/秒起", unit: ""}], checked_at: "2026-08-09", source_url: "https://www.volcengine.com/docs/82379/1544106", status: "current", note: "活动至 2026-09-07 14:00（UTC+8）"}},
    {id: "tool-gpt-image-api", type: "toolbox", title: "GPT Image API", source: "starter", category: "图像与视频", purpose: "使用 OpenAI API 生成与编辑图片，适合复杂指令、局部修改和图中文字。", model: "gpt-image-2", url: "https://platform.openai.com/api-keys", source_url: "https://platform.openai.com/docs/guides/image-generation", price_url: "https://openai.com/api/pricing/", pricing: {summary: "按图片尺寸、质量与图像 token 计费；点击更新可重新核验官方当前档位。", currency: "USD", items: [], checked_at: "2026-08-09", source_url: "https://openai.com/api/pricing/", status: "unavailable", note: "当前网络未能读取官方价格表，未写入猜测数字"}}
  ]},
  notice_reports: {version: 1, updated_at: "", reports: []},
  butler_sources: {
    sources: [
      {id: "openai", name: "OpenAI News", url: "https://openai.com/news/", feed: "", category: "模型与技术", priority: 5, enabled: true},
      {id: "cloudflare", name: "Cloudflare Blog", url: "https://blog.cloudflare.com/", feed: "https://blog.cloudflare.com/rss/", category: "产品与实践", priority: 5, enabled: true},
      {id: "anthropic", name: "Anthropic News", url: "https://www.anthropic.com/news", feed: "", category: "模型与技术", priority: 5, enabled: true},
      {id: "google-ai", name: "Google AI", url: "https://blog.google/technology/ai/", feed: "", category: "模型与技术", priority: 4, enabled: true}
    ],
    categories: ["模型与技术", "产品与实践", "行业动态", "学术研究"],
    watch_topics: [], exclude_keywords: []
  },
  butler_state: {version: 2, updated_at: "", chest: [], read_later: [], watch_topics: [], sources: [], toolbox: [], task_log: [], custom_categories: []},
  daily_questions: {version: 1, items: [], updated_at: ""},
  permissions: {steward_mode: false, memory_assist_enabled: true, permanent: true, scope: "project", enabled_at: null, updated_at: ""},
  automation_state: {version: 1, last_check: "", jobs: {}},
  local_state: {version: 1, updated_at: "", values: {}},
  weather_cache: {version: 1, updated_at: "", location: {}, current: {}},
  generation_tasks: {version: 1, items: []},
  tasks: {version: 1, tasks: []},
  audit_log: {version: 1, events: []}
});
