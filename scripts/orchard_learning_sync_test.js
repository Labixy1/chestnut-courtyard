const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('pages/orchard.html', 'utf8');
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert(start >= 0, `missing function ${name}`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const storage = new Map();
let writes = 0;
const localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => { storage.set(key, value); writes += 1; }
};
const sandbox = {console, localStorage, window: {CozyButler: {persistLocal() {}}}};
vm.createContext(sandbox);
vm.runInContext("let knowledgeRenderFingerprint='';", sandbox);
[
  'readJson', 'writeJson', 'localCalendarDate', 'hashText', 'cleanTitle',
  'getKnowledgeTopics', 'learningText', 'uniqueLearningPoints',
  'blackboardLearningEntry', 'noticeLearningEntry', 'syncLearningSourcesToTopics'
].forEach(name => vm.runInContext(extractFunction(name), sandbox));

localStorage.setItem('cozy_blackboard_answers', JSON.stringify([{
  attemptId: 'attempt_1', date: '2026-08-17', title: '企业级客服 Agent 评测',
  review: {
    priorityFix: '先按风险分层建立任务样本，并为每层设置通过条件。',
    correctionPath: '保留任务成功率，再加入失败、副作用与回归门槛。',
    scoreBreakdown: [{max: 25, awarded: 12, teaching: '把指标和业务风险一一对应，说明不通过时如何处置。'}],
    strengths: [{evidence: '任务成功率', whyGood: '已经抓住了结果指标。'}],
    plainLanguageCoaching: {remember: ['评测要同时覆盖成功、失败和副作用。'], answerSteps: ['先定义真实任务，再按风险分层。'], memoryHook: '任务、风险、门槛、处置。'}
  }
}]));
localStorage.setItem('cozy_notice_notes', JSON.stringify([{
  key: 'notice_1', title: 'AI 产品更新', url: 'https://example.com/article', updated_at: '2026-08-17T08:00:00Z',
  content: '这个功能真正降低的是用户的确认成本。上线前还要验证错误建议会不会增加返工。'
}]));
writes = 0;
vm.runInContext('syncLearningSourcesToTopics()', sandbox);
let topics = JSON.parse(localStorage.getItem('cozy_orchard_topics'));
assert.equal(topics.length, 2);
assert.equal(topics.find(item => item.id === 'topic_blackboard_learning').entries.length, 1);
assert.match(topics.find(item => item.id === 'topic_blackboard_learning').entries[0].insight, /风险分层/);
assert.equal(topics.find(item => item.id === 'topic_notice_learning').entries[0].sourceId, 'notice_1');
const writesAfterFirstSync = writes;
vm.runInContext('syncLearningSourcesToTopics()', sandbox);
assert.equal(writes, writesAfterFirstSync, 'repeat sync must not write or duplicate topics');

localStorage.setItem('cozy_notice_notes', JSON.stringify([{
  key: 'notice_1', title: 'AI 产品更新', url: 'https://example.com/article', updated_at: '2026-08-17T09:00:00Z',
  content: '新判断：先验证用户是否愿意为减少返工而改变工作流。'
}]));
vm.runInContext('syncLearningSourcesToTopics()', sandbox);
topics = JSON.parse(localStorage.getItem('cozy_orchard_topics'));
const noticeTopic = topics.find(item => item.id === 'topic_notice_learning');
assert.equal(noticeTopic.entries.length, 1, 'edited note must replace its source entry');
assert.match(noticeTopic.entries[0].insight, /改变工作流/);

localStorage.setItem('cozy_notice_notes', '[]');
vm.runInContext('syncLearningSourcesToTopics()', sandbox);
topics = JSON.parse(localStorage.getItem('cozy_orchard_topics'));
assert(!topics.some(item => item.id === 'topic_notice_learning'), 'cleared note must leave no stale generated topic');
assert(topics.some(item => item.id === 'topic_blackboard_learning'), 'blackboard learning must remain intact');
console.log('orchard learning sync test ok');
