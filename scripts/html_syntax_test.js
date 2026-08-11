const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = ['index.html', ...fs.readdirSync('pages').filter(name => name.endsWith('.html')).map(name => path.join('pages', name))];
let count = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
  scripts.forEach((code, index) => {
    try { new vm.Script(code, {filename: `${file}:inline-${index + 1}`}); }
    catch (error) { throw new Error(`${file} inline script ${index + 1}: ${error.message}`); }
    count += 1;
  });
}
const travel = fs.readFileSync('pages/travel.html', 'utf8');
if (!travel.includes('<option value="">选择一段旅行</option>')) throw new Error('travel reflection must start without a selected trip');
if (!travel.includes("if(select)select.value='';")) throw new Error('travel reflection clear action must reset the selected trip');
if (!travel.includes('data-travel-view="records"') || !travel.includes("showMobileTravelView('records'")) throw new Error('mobile travel must use separate views');
const home = fs.readFileSync('index.html', 'utf8');
const mobile = fs.readFileSync('core/mobile.js', 'utf8');
const serviceWorker = fs.readFileSync('sw.js', 'utf8');
if (!home.includes('href="pages/heart_hollow.html"') || !home.includes('<span class="tag">树洞</span>')) throw new Error('desktop tree hollow entry must be restored');
if (!home.includes('.stage.has-panorama .spot.orchard{left:15%;top:39%') || !home.includes('.stage.has-panorama .spot.oldtree{left:84%;top:45%')) throw new Error('mobile orchard and tree hollow hotspots must stay separate');
if (!home.includes('id="notice-cadence"') || !home.includes('cozy_notice_notes')) throw new Error('notice cadence and reading notes must be present');
if (!home.includes("每周一、周三、周五 08:00 更新 · 往期巡报 ") || !home.includes("report?.id!=='fallback'")) throw new Error('notice cadence must show the fixed schedule and actual archived report count');
if (!mobile.includes("'memory_nook','密阁','private','pages/memory_nook.html'")) throw new Error('mobile private nook must link directly to memory_nook');
if (fs.existsSync('pages/private_wing.html') || serviceWorker.includes('pages/private_wing.html')) throw new Error('legacy private wing transition must be removed');
if (!fs.readFileSync('pages/orchard.html', 'utf8').includes('orchard_field.webp')) throw new Error('orchard must use the optimized WebP background');
const orchard = fs.readFileSync('pages/orchard.html', 'utf8');
if (!orchard.includes("slice(0,-1).slice(-8)") || !orchard.includes("current_topic_id:chat?.topicId||''")) throw new Error('orchard chat must send prior turns separately from the current question');
if (!orchard.includes('openEmptyPlotPanel()') || !orchard.includes('这块空地的知识专题')) throw new Error('empty orchard plots must open a knowledge-topic empty state');
if (!orchard.includes('fingerprint===knowledgeRenderFingerprint') || !orchard.includes("details[open][data-topic-id]") || orchard.includes("open=first?' open':''")) throw new Error('knowledge topics must preserve manual collapse state across sync renders');
if (!home.includes('String(item.awarded??0)') || !home.includes('String(item.max??25)')) throw new Error('blackboard must display explicit zero scores');
if (!serviceWorker.includes("url.pathname.includes('/assets/')")) throw new Error('static assets must use the cache-first path');
if (!serviceWorker.includes("cozy-shell-v8") || !fs.readFileSync('core/pwa.js','utf8').includes("updateViaCache:'none'")) throw new Error('PWA shell updates must bypass stale service worker cache');
if (!home.includes("return remote?[]:[NOTICE_REPORT_FALLBACK()]") || !home.includes('页面不会再显示旧版占位巡报')) throw new Error('remote noticeboard must not show bundled fallback reports');
if (!home.includes('async function openNotice(){') || !home.includes('await CORE_READY;')) throw new Error('noticeboard must wait for cloud core data before rendering');
if (!home.includes('refreshNoticeReportsFromCloud()') || !home.includes("cache:'no-store',credentials:'same-origin'")) throw new Error('noticeboard must revalidate cloud reports when opened');
if (!home.includes('Promise.all(Object.entries(files).map')) throw new Error('core cloud data must load in parallel');
if (!home.includes('async function openToolbox(){') || !home.includes("cozyApi('/api/state',undefined,6000)")) throw new Error('toolbox must refresh cloud state when opened');
if (!home.includes('>加入工具箱</button>') || !home.includes('source,instruction:')) throw new Error('notice tool import must send the existing report context');
if (home.includes('removeCourtyardScene(') || home.includes('从小院照片合集中移除')) throw new Error('courtyard background collection must not expose deletion controls');
if (!home.includes('.photo-album-cover img{position:static;width:100%;height:100%;object-fit:contain')) throw new Error('photo album covers must preserve source aspect ratios');
console.log(`html syntax test ok: ${files.length} pages; ${count} inline scripts`);
