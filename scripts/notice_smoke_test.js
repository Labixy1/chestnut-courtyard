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
for (const expected of ['An actionable archive test', 'This is the original English summary.', '中文翻译', '这是原始英文摘要的中文翻译。', 'AI 总结', '这是中文摘要。', '英文原摘要', '查看原文', '稍后看', '已入栗夹']) {
  if (!rendered.includes(expected)) throw new Error('category card missing: ' + expected);
}
if (!rendered.includes('<details class="notice-translation">')) throw new Error('Chinese summary must be collapsed by default');
if (!rendered.includes('<details class="category-item">') || rendered.includes('<details class="category-archive" open')) throw new Error('category view must start compact and expand one item at a time');
if (!html.includes('.category-archive>summary:after') || !html.includes('.category-archive[open]>summary:after')) throw new Error('category disclosure icons must only target direct summaries');
const cardOrder = rendered.indexOf('AI 总结') < rendered.indexOf('中文翻译') && rendered.indexOf('中文翻译') < rendered.indexOf('英文原摘要');
if (!cardOrder) throw new Error('AI summary and translation must appear before the source summary');
if (context.noticeAISummary({title:'No model summary',summary:'Source text only.'}) !== '') throw new Error('the frontend must not fabricate an AI summary');
if (context.noticeAISummary({ai_summary:'自动中文整理暂时没有可靠完成，阿栗先保留来源，避免把英文原文误当成中文总结；可以打开原文核对详情。'}) !== '') throw new Error('failed-summary boilerplate must never be displayed as an AI summary');
if (context.noticeAISummary({ai_summary:'云端生成的真实总结。'}) !== '云端生成的真实总结。') throw new Error('a persisted AI summary must be preserved');
const chineseCard = context.reportCardHtml({title:'中文资讯',summary:'这是一段本来就是中文的原始摘要，不应该再显示翻译入口。',ai_summary:'这是单独保留的 AI 总结。',url:'https://example.com/chinese'},'行业动态');
if (chineseCard.includes('<summary>中文翻译</summary>') || !chineseCard.includes('AI 总结')) throw new Error('Chinese source should skip translation but keep AI summary');
const productTipCard = context.reportCardHtml({title:'产品实践资讯',summary:'某产品公开了新的智能体工作流。',ai_summary:'这次更新改变了任务编排方式，但真实完成率仍需验证。',product_tip:'产品经理应先选高频真实任务验证完成率、人工接管率和失败恢复，再决定是否扩大使用范围。',url:'https://example.com/product-practice'},'产品与实践');
if (!productTipCard.includes('产品经理关注点') || !productTipCard.includes('data-product-tip=')) throw new Error('a grounded Chinese product tip must render and persist with notice actions');
const noProductTipCard = context.reportCardHtml({title:'普通公司动态',summary:'一家公司发布了季度组织消息。',ai_summary:'该消息主要说明组织安排变化。',product_tip:'',url:'https://example.com/company-update'},'行业动态');
if (noProductTipCard.includes('产品经理关注点')) throw new Error('empty product tips must not render a forced product lesson');
const openaiLinks = context.reportCardHtml({title:'OpenAI update',summary:'English summary.',translation_zh:'中文翻译。',ai_summary:'AI 总结。',url:'https://openai.com/index/example-update/',localized_url:'https://openai.com/zh-Hans-CN/index/example-update/'},'模型与技术');
if (!openaiLinks.includes('查看中文全文') || !openaiLinks.includes('/zh-Hans-CN/index/example-update/') || !openaiLinks.includes('英文原文')) throw new Error('OpenAI article should prefer the Chinese full-text link');
const googleSourceCard = context.reportCardHtml({title:'Google RSS item',summary:'Summary',url:'https://news.google.com/rss/articles/opaque',source_url:'https://www.qbitai.com/'},'行业动态');
if (!googleSourceCard.includes('原文地址待修复') || googleSourceCard.includes('href="https://news.google.com')) throw new Error('Google News relay links must never be replaced by a publisher homepage');
const brokenGoogleCard = context.reportCardHtml({title:'Broken Google RSS item',summary:'Summary',url:'https://news.google.com/rss/articles/opaque'},'行业动态');
if (!brokenGoogleCard.includes('原文地址待修复') || brokenGoogleCard.includes('href="https://news.google.com')) throw new Error('unresolved Google News links must not render as clickable dead links');
if (context.noticeItemDisplayable({title:'Homepage masquerading as article',summary:'A distinct summary.',url:'https://openai.com/news/',source_url:'https://openai.com/news/'}) !== false) throw new Error('publisher homepage must not be displayed as an article');
if (context.noticeItemDisplayable({title:'Repeated title',summary:'Repeated title',url:'https://example.com/articles/1'}) !== false) throw new Error('title-only cards must not be displayed');
const duplicateSummaryCard=context.reportCardHtml({title:'同一句标题',summary:'同一句标题',ai_summary:'这是有依据的独立总结。',url:'https://example.com/article'},'行业动态');
if (duplicateSummaryCard.includes('class="notice-original-summary"')) throw new Error('a summary identical to the title must not be rendered again');
if (context.noticeItemDisplayable({title:'错误码 - 阿里云帮助文档',ai_summary:'错误码发生变化。'})) throw new Error('generic documentation pages must not be displayed as news');
if (context.noticeItemDisplayable({title:'豆包回应推荐酒店要收费',ai_summary:'这意味着豆包将会收取费用。',url:'https://example.com/articles/response-1'})) throw new Error('a response article must not be displayed with a fabricated conclusion');
if (!context.noticeItemDisplayable({title:'豆包回应推荐酒店要收费',ai_summary:'豆包回应相关传言，原文未确认收费。',url:'https://example.com/articles/response-2'})) throw new Error('a cautious response summary should remain displayable');
const fallbackTranslationCard = context.reportCardHtml({title:'English update',summary:'English source summary.',ai_summary:'已有的中文 AI 总结。',url:'https://example.com/english'},'模型与技术');
if (fallbackTranslationCard.includes('<summary>中文翻译</summary>') || !fallbackTranslationCard.includes('AI 总结')) throw new Error('Missing translation must not duplicate the AI summary');
const invalidTranslationCard = context.reportCardHtml({title:'Broken translation',summary:'English source summary.',translation_zh:'English source summary.',ai_summary:'已有的中文 AI 总结。',url:'https://example.com/broken-translation'},'模型与技术');
if (invalidTranslationCard.includes('<summary>中文翻译</summary>')) throw new Error('English text must never be labeled as a Chinese translation');
const datedCard = context.reportCardHtml({id:'dated',title:'Dated update',summary:'Summary',published_at:'2026-08-11T08:00:00Z'},'行业动态');
if (!datedCard.includes('8月11日') || datedCard.includes('本周 ·')) throw new Error('published_at must render as a concrete date');
const undatedCard = context.reportCardHtml({id:'undated',title:'Undated update',summary:'Summary'},'行业动态');
if (!undatedCard.includes('本周 ·')) throw new Error('missing publication date must render as this week');
context.BB_STATE = {questionData:{title:'资讯题',question:'结合一条资讯判断产品价值。',types:['时事判断'],materials:[],standard:[],date:'2026-08-11',related_notice:{id:'dated',title:'Dated update'}}};
if (!context.renderBlackboardQuestion(context.BB_STATE.questionData,'').includes('查看相关资讯')) throw new Error('news-linked question must expose the related notice action');
const plainQuestion = {...context.BB_STATE.questionData, related_notice:null};
if (context.renderBlackboardQuestion(plainQuestion,'').includes('查看相关资讯')) throw new Error('general question must not expose a related notice action');
const commercialAnswer='我会验证用户价值、付费意愿和单位经济模型';
const commercialReference=['验证用户价值','验证付费意愿','计算单位经济'];
const commercialIdeal='判断：商业可行性不能用注册量或模型效果单独证明，而要同时成立用户价值、真实付费和可持续单位经济。拆解：1. 先锁定高频且结果可判断的核心任务，与用户现有做法比较。2. 在价值成立后设置真实价格和付费动作，区分口头意愿与实际支付。3. 最后计算收入、模型调用、人工介入和获客等成本。验证：记录任务完成率、重复使用率、真实付费转化率、客单价、单次贡献毛利和人工分钟数，并预先设置继续、调整和停止线。边界：免费试用活跃不等于付费意愿，毛利为正也不代表获客后能盈利；高风险场景还要单列事故成本。例子：验证简历诊断功能时，先比较修改前后的任务完成与返工，再让用户面对真实价格完成支付，最后核算每份报告收入减模型和人工成本后的贡献毛利。';
const commercialQuestion={title:'商业验证',question:'如何验证商业可行性？',types:['产品判断'],materials:[],standard:commercialReference,idealAnswer:commercialIdeal,idealAnswerVersion:1,rubric:context.defaultBlackboardRubric(commercialReference)};
const commercialResult={
  score_breakdown:[
    {rubric_id:'comprehension',criterion:'题意理解与核心判断',max:20,awarded:18,evidence:'验证用户价值、付费意愿和单位经济模型',reason:'准确抓住商业可行性的三个核心判断层次。',teaching:'把核心判断改成先验证价值、再验证支付、最后核算经济性的明确顺序。'},
    {rubric_id:'coverage',criterion:'任务完成与要点覆盖',max:30,awarded:25,evidence:'用户价值、付费意愿和单位经济模型',reason:'三个必要角度都已经覆盖，没有把商业可行性缩成使用次数。',teaching:'为每个角度各增加一个可观察的判断信号。'},
    {rubric_id:'reasoning',criterion:'推理链条与证据支撑',max:30,awarded:9,evidence:'我会验证用户价值',reason:'有判断对象，但还没有解释三者为何要按顺序相互验证。',teaching:'用“只有价值成立才测付费，只有付费覆盖成本才可持续”的因果句连接三层。'},
    {rubric_id:'transfer',criterion:'边界意识与迁移应用',max:20,awarded:7,evidence:'单位经济模型',reason:'已经意识到成本收益，但还没有可执行的通过线或停止线。',teaching:'计算单次贡献毛利，并写明低于阈值时停止或降级。'}
  ],score_summary:'三个判断层次都已覆盖，主要缺口是把它们连成可以执行的决策链。',
  requirement_map:[
    {reference_point:'验证用户价值',relation:'partial',evidence:'用户价值',assessment:'已识别验证对象，但没有具体用户任务。',teaching:'访谈目标用户并记录核心任务完成率。'},
    {reference_point:'验证付费意愿',relation:'partial',evidence:'付费意愿',assessment:'已识别付费判断，但没有真实价格测试。',teaching:'设置两个真实价格档并统计付费转化率。'},
    {reference_point:'计算单位经济',relation:'partial',evidence:'单位经济模型',assessment:'已考虑成本收益，但没有计算口径。',teaching:'计算收入减模型调用成本后的贡献毛利并设置阈值。'}
  ],strengths:[{evidence:'用户价值、付费意愿和单位经济模型',why_good:'没有把商业可行性等同于流量，而是同时考虑价值、支付和成本。'}],direction:'partly_correct',correction_path:'保留这三个层次，先补验证顺序，再为每层增加方法、指标与停止条件。',priority_fix:'先把三个名词连成验证顺序，并为每一步写一个通过信号。',personalized_revision:'判断：我会验证用户价值、付费意愿和单位经济模型，而且会按价值、支付、成本的顺序推进，因为前一层不成立时，后一层的数据没有商业意义。拆解：1. 用户价值用真实目标用户的高频任务验证，比较现有方案与新功能的完成率、耗时和返工。2. 价值成立后设置真实价格与支付动作，不把问卷里的“愿意”当成付费。3. 最后把收入减去模型调用、人工介入和获客成本，判断贡献毛利能否随规模改善。验证：预先设置任务完成率、重复使用率、真实付费转化率、客单价、单次贡献毛利和人工分钟数的继续线与停止线。边界：免费活跃不等于商业成立，早期人工服务也可能掩盖成本；高风险场景还要单列错误损失。例子：做简历诊断时，先让求职者用自己的材料完成一次任务，再测试真实价格支付，最后核算每份报告的收入、模型与人工成本，三层都过线才扩大。',plain_language_coaching:{what_the_question_wants:'这题要判断一个高成本 AI 功能能不能持续赚钱，不是只看用户觉得好不好用。',answer_steps:['先验证用户是否真的需要，并明确哪项核心任务变好了。','再用真实价格和支付动作验证付费意愿，不把口头认可当成交。','最后计算收入减模型、人工和获客成本后的贡献毛利，并设置停止线。'],remember:['商业可行性必须同时满足用户价值、真实付费和单位经济。','前一层不成立时，不要用后一层的漂亮数据掩盖问题。'],memory_hook:'先看价值，再测付费，最后算清每单赚不赚钱。'}
};
const normalizedReview=context.normalizeBlackboardReview(commercialResult,commercialAnswer,commercialQuestion);
const reviewHtml=context.renderBlackboardResult(commercialQuestion,commercialAnswer,normalizedReview);
for(const expected of ['得分与学习建议','大白话学会这题','真正要记住的点','答题口诀','你的原话：“用户价值”','下一步先练这一件事','结合你的回答给的建议','阿栗的完整面试回答','不是要点清单','评分参考要点','结合你原答案的面试升级版','没有把商业可行性等同于流量','准确充分','部分成立'])if(!reviewHtml.includes(expected))throw new Error('tutoring-style grading missing: '+expected);
if(reviewHtml.includes('阿栗帮答')||reviewHtml.includes('AI 修改建议'))throw new Error('legacy generic grading blocks must be removed');
if(!context.buildBbReview(commercialAnswer,commercialQuestion,'模型失败').reviewUnavailable)throw new Error('model failure must remain explicit instead of fabricating local feedback');

if(context.detectButlerTaskKind('你后面关注一下cloudflare他的新增加的钱包功能')!=='watch_topic')throw new Error('product feature updates must not be mistaken for a new media source');
if(context.detectButlerTaskKind('新增 36氪 来源')!=='media_source')throw new Error('explicit media source requests must remain media_source tasks');

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
context.prepareNoticeFoundResults();
context.showNoticeView('current');
const currentRendered = node('notice-content').innerHTML;
if (!currentRendered.includes('留言独有资料')) throw new Error('unique found item was removed');
if (!currentRendered.includes('来自留言：“查找留言独有资料”')) throw new Error('found item must identify its source request');
if (currentRendered.indexOf('留言找到的内容') > currentRendered.indexOf('热点速览')) throw new Error('message-matched news must appear before the general report');
if ((currentRendered.match(/<h4>留言独有资料<\/h4>/g) || []).length !== 1) throw new Error('found items were not deduplicated internally');
if ((currentRendered.match(/<h4>主栏目同链接<\/h4>/g) || []).length !== 1) throw new Error('same-url found item duplicated a primary section');
if ((currentRendered.match(/<h4>主栏目同标题<\/h4>/g) || []).length !== 1) throw new Error('same-title found item duplicated a primary section');
const seenRequests=JSON.parse(storage.get('cozy_notice_requests'));
const locallySeen=JSON.parse(storage.get('cozy_notice_found_seen_v1'));
if (!Object.keys(locallySeen).some(key=>key.includes('found-only'))) throw new Error('displayed found items must be marked as seen on this device');
if (seenRequests[0].found_items_seen_at || seenRequests[0].updatedAt) throw new Error('one device must not mark a found item as seen for every synced device');
context.prepareNoticeFoundResults();
context.showNoticeView('current');
if (!node('notice-content').innerHTML.includes('留言独有资料')) throw new Error('in-memory found items must survive same-page status refreshes');
vm.runInContext('NOTICE_FOUND_RESULTS=[]',context);
context.prepareNoticeFoundResults();
context.showNoticeView('current');
if (node('notice-content').innerHTML.includes('留言独有资料')) throw new Error('seen found items must not remain after a refresh');
storage.delete('cozy_notice_found_seen_v1');
context.prepareNoticeFoundResults();
context.showNoticeView('current');
if (!node('notice-content').innerHTML.includes('留言独有资料')) throw new Error('a second device must be able to see the same found item once');

const responseFound=context.acceptNoticeFollowupResponse({matches:[{request_id:'request-kv-limit',request_text:'关注 Cloudflare 钱包',items:[{title:'Cloudflare Wallets 更新',url:'https://example.com/cloudflare-wallets',summary:'钱包功能更新'}]}]});
if(responseFound.length!==1)throw new Error('weekly response fallback must preserve message-matched news when KV writes are exhausted');
context.showNoticeView('current');
if(!node('notice-content').innerHTML.includes('Cloudflare Wallets 更新')||!node('notice-content').innerHTML.includes('来自留言：“关注 Cloudflare 钱包”'))throw new Error('response fallback must render the matched item with its source request');

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

vm.runInContext("CORE={notice_reports:{reports:[{id:'existing',hot_items:[],sections:[]}]}};cozyApi=async()=>{throw new Error('HTTP 503')}",context);
context.runWeeklyNow().then(()=>{
  const refreshState=JSON.parse(storage.get('cozy_notice_refresh_status'));
  if(refreshState.status!=='completed'||!/本次更新未完成：HTTP 503。现有 1 版巡报未受影响/.test(refreshState.message))throw new Error('mobile 503 must preserve an existing report and explain the precise refresh failure');
}).catch(error=>{throw error;});

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
