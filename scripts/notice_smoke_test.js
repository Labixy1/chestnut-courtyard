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
  title: '可操作的归档测试资料',
  summary: '这是原始摘要。',
  ai_summary: '这是 AI 总结。',
  media: '测试媒体',
  published: '2026-08-06',
  url: 'https://example.com/article',
}]));
vm.runInContext("CORE={notice_reports:{reports:[{sections:[],insights:[],hot_items:[]}]}}", context);
context.showNoticeView('categories');
const rendered = node('notice-content').innerHTML;
for (const expected of ['可操作的归档测试资料', '查看原文', '加入待读', '已入栗夹', '这是 AI 总结。']) {
  if (!rendered.includes(expected)) throw new Error('category card missing: ' + expected);
}

vm.runInContext("CORE={notice_reports:{reports:[{id:'week_test',week_start:'2026-08-03',week_end:'2026-08-09',focus_title:'本周重点标题',hot_items:[{title:'完整热点',summary:'热点摘要',category:'模型与技术'}],sections:[{name:'国内外动态',items:[{title:'完整周报正文',summary:'正文摘要',category:'行业动态'}]}],insights:['具体总结']}]}}", context);
context.showNoticeView('weeks');
const weeksRendered = node('notice-content').innerHTML;
for (const expected of ['<details', '完整热点', '完整周报正文', '具体总结', '本周重点标题']) {
  if (!weeksRendered.includes(expected)) throw new Error('weekly history missing: ' + expected);
}

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

console.log('notice smoke test ok: voice enabled; actions mutually exclusive; persistent running task; archive card actionable; weekly report expandable');
