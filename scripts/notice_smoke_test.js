const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(code => code.trim());

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    const classes = new Set();
    nodes.set(id, {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      style: {},
      className: '',
      disabled: false,
      attributes: {},
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      dataset: {},
      appendChild() {},
      addEventListener() {},
      dispatchEvent() {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    });
  }
  return nodes.get(id);
}

const storage = new Map();
const context = {
  console,
  URL,
  Date,
  Math,
  JSON,
  Promise,
  setTimeout,
  clearTimeout,
  Event: function Event(type) { this.type = type; },
  matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
  location: { protocol: 'file:', hostname: '', port: '' },
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  document: {
    getElementById: node,
    querySelectorAll() { return []; },
    createElement() { return node('created-' + Math.random()); },
    addEventListener() {},
  },
  fetch: async () => { throw new TypeError('offline in smoke test'); },
};
context.window = context;
vm.createContext(context);
for (const code of scripts) vm.runInContext(code, context);

if (!html.includes('const NOTICE_VOICE_ENABLED = true')) throw new Error('voice input is not enabled');

context.setNoticeBusy('send', true);
if (![node('notice-send-btn'), node('notice-parse-btn'), node('notice-mic-btn')].every(button => button.disabled)) {
  throw new Error('send state did not lock all actions');
}
context.setNoticeBusy('send', false);
if (node('notice-send-btn').disabled || node('notice-parse-btn').disabled || node('notice-mic-btn').disabled) {
  throw new Error('all actions should unlock after send');
}
context.setNoticeBusy('parse', true);
if (![node('notice-send-btn'), node('notice-parse-btn'), node('notice-mic-btn')].every(button => button.disabled)) {
  throw new Error('parse state did not lock all actions');
}
context.setNoticeBusy('parse', false);
if (node('notice-send-btn').disabled || node('notice-parse-btn').disabled || node('notice-mic-btn').disabled) {
  throw new Error('all actions should unlock after parse');
}

storage.set('cozy_notice_chest', JSON.stringify([{
  category: '记忆系统',
  title: 'An actionable archive test',
  summary: 'This is the original English summary.',
  translation_zh: '这是原始英文摘要的中文翻译。',
  ai_summary: '这是中文摘要。',
  media: '测试媒体',
  published: '2026-08-06',
  url: 'https://example.com/article',
}]));
vm.runInContext("CORE={notice_reports:{reports:[{sections:[],insights:[],hot_items:[]}]}}", context);
context.showNoticeView('categories');
const rendered = node('notice-content').innerHTML;
for (const expected of ['An actionable archive test', 'This is the original English summary.', '查看中文翻译', '这是原始英文摘要的中文翻译。', 'AI总结', '这是中文摘要。', '查看原文', '稍后看', '已入栗夹']) {
  if (!rendered.includes(expected)) throw new Error('category card missing: ' + expected);
}
if (!rendered.includes('<details class="notice-translation">')) throw new Error('Chinese summary must be collapsed by default');
const cyberSummary = context.noticeAISummary({title:'Expanding Daybreak as the Cyber Defense Window Narrows', summary:'Meet GPT-5.6-Cyber for authorized vulnerability research and security testing.'});
if (!/网络安全|漏洞研究/.test(cyberSummary) || /价格性能|单位成本/.test(cyberSummary)) throw new Error('cyber article was summarized as a generic GPT-5.6 update');
const chineseCard = context.reportCardHtml({title:'中文资讯',summary:'这是一段本来就是中文的原始摘要，不应该再显示翻译入口。',ai_summary:'这是单独保留的 AI 总结。',url:'https://example.com/chinese'},'行业动态');
if (chineseCard.includes('查看中文翻译') || !chineseCard.includes('AI总结')) throw new Error('Chinese source should skip translation but keep AI summary');
const openaiLinks = context.reportCardHtml({title:'OpenAI update',summary:'English summary.',translation_zh:'中文翻译。',ai_summary:'AI 总结。',url:'https://openai.com/index/example-update/'},'模型与技术');
if (!openaiLinks.includes('查看中文全文') || !openaiLinks.includes('/zh-Hans-CN/index/example-update/') || !openaiLinks.includes('英文原文')) throw new Error('OpenAI article should prefer the Chinese full-text link');
const fallbackTranslationCard = context.reportCardHtml({title:'English update',summary:'English source summary.',ai_summary:'已有的中文 AI 总结。',url:'https://example.com/english'},'模型与技术');
if (fallbackTranslationCard.includes('查看中文翻译') || !fallbackTranslationCard.includes('AI总结')) throw new Error('Missing translation must not duplicate the AI summary');

storage.set('cozy_notice_requests', JSON.stringify([{
  date:'2026-08-01',
  text:'查找留言独有资料',
  found_items:[
    {title:'主栏目同链接',url:'https://example.com/same-url',summary:'不应重复'},
    {title:'主栏目同标题',url:'https://example.com/alternate-url',summary:'不应重复'},
    {title:'留言独有资料',url:'https://example.com/found-only',summary:'应保留'},
    {title:'留言独有资料',url:'https://example.com/found-only-copy',summary:'留言内部也不应重复'},
  ],
}]));
vm.runInContext("CORE={notice_reports:{reports:[{id:'current_test',week_start:'2026-08-03',week_end:'2099-08-09',hot_items:[{title:'主栏目同链接',url:'https://example.com/same-url',summary:'主栏目内容'}],sections:[{name:'产品相关动态',items:[{title:'主栏目同标题',url:'https://example.com/main-title',summary:'主栏目内容'}]}],insights:[]}]}}", context);
context.showNoticeView('current');
const currentRendered = node('notice-content').innerHTML;
if (!currentRendered.includes('留言独有资料')) throw new Error('unique found item was removed');
if ((currentRendered.match(/<h4>留言独有资料<\/h4>/g) || []).length !== 1) throw new Error('found items were not deduplicated internally');
if ((currentRendered.match(/<h4>主栏目同链接<\/h4>/g) || []).length !== 1) throw new Error('same-url found item duplicated a primary section');
if ((currentRendered.match(/<h4>主栏目同标题<\/h4>/g) || []).length !== 1) throw new Error('same-title found item duplicated a primary section');

vm.runInContext("CORE={notice_reports:{reports:[{id:'week_test',week_start:'2026-08-03',week_end:'2026-08-09',focus_title:'本周重点标题',hot_items:[{title:'完整热点',summary:'热点摘要',category:'模型与技术'}],sections:[{name:'国内外动态',items:[{title:'完整周报正文',summary:'正文摘要',category:'行业动态'}]}],insights:['具体总结']}]}}", context);
context.showNoticeView('weeks');
const weeksRendered = node('notice-content').innerHTML;
for (const expected of ['<details', '完整热点', '完整周报正文', '具体总结', '本周重点标题']) {
  if (!weeksRendered.includes(expected)) throw new Error('weekly history missing: ' + expected);
}

vm.runInContext("CORE={notice_reports:{reports:Array.from({length:5},(_,index)=>({id:'report_'+index,hot_items:[],sections:[]}))}}", context);
context.updateNoticeCadence();
if (node('notice-cadence').textContent !== '每周一、周三、周五 08:00 更新 · 往期巡报 5 版') throw new Error('notice cadence count must match weekly archive count');
vm.runInContext("CORE={notice_reports:{reports:[]}}", context);
context.updateNoticeCadence();
if (!node('notice-cadence').textContent.endsWith('往期巡报 0 版')) throw new Error('fallback report must not be counted as an archived edition');
context.CozyRuntime = {dataSource:'remote'};
vm.runInContext("CORE={notice_reports:{reports:[]}}", context);
context.showNoticeView('current');
if (!node('notice-content').innerHTML.includes('页面不会再显示旧版占位巡报') || node('notice-content').innerHTML.includes('AI Agent 工具链继续')) throw new Error('remote empty state must not render bundled fallback news');
context.CozyRuntime = {dataSource:'bundle'};

if (!html.includes("'/api/assistant/start'")) throw new Error('notice tasks are not started asynchronously');
storage.set('cozy_notice_jobs', JSON.stringify([{
  task_id:'task_persist_test', text:'帮我整理一份资料', status:'running', message:'阿栗正在读取公告板与知识库。'
}]));
context.renderNoticeJobs();
if (!node('notice-task-list').innerHTML.includes('运行中') || !node('notice-task-list').innerHTML.includes('帮我整理一份资料')) {
  throw new Error('running notice task was not rendered');
}
node('notice-task-list').innerHTML = '';
context.renderNoticeJobs();
if (!node('notice-task-list').innerHTML.includes('运行中')) throw new Error('running task did not survive panel reopen');

console.log('notice smoke test ok: voice enabled; actions mutually exclusive; persistent running task; archive card actionable; found-item dedupe; weekly report expandable');
