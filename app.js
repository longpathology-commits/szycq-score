// 守正亦出齐 · A股多因子实时评分模型 - 前端
// 依赖静态数据：name_index.json + ranking.json + data/<code>.json

const APP_VER = '202609160900'; // 每次部署递增；所有静态资源加 ?v 强制浏览器刷新缓存
function dataUrl(u){ return u + (u.indexOf('?')>=0 ? '&' : '?') + 'v=' + APP_VER; }
// 解压读取 gzip 桶文件（桶已 gzip 压缩以压缩部署体积）
async function fetchGz(url){
  const r = await fetch(url, { cache:'force-cache' });
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const buf = await r.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  const txt = await new Response(stream).text();
  return JSON.parse(txt);
}

let nameIdx = [];   // [{c, n}]
let rankTop = [];   // 前10 + 全部 (此处用前10)
let livePrice = {}; // {code: price}
let currentCode = null;
let currentData = null;
let currentMetric = 'np';  // quarterly chart metric (np / rev / both)
let currentKPeriod = 'daily'; // daily / weekly / monthly
let rankList = [];        // 全市场排名 [{rank,code,name,total}]（懒加载 + localStorage 缓存）

// ----- 评分规则（与 build_dist.js 完全一致） -----
function num(v){ if(v==null||v===''||isNaN(+v)) return null; return +v; }
function r2(x){ return x==null?null:Math.round(x*100)/100; }
function r4(x){ return x==null?null:Math.round(x*10000)/10000; }
function percentile(current, arr){
  if(current==null||!(current>0)||!arr||arr.length<6) return null;
  const below=arr.filter(v=>v<current).length;
  return (below/arr.length)*100;
}
function scPE(pct){ if(pct==null)return 0; if(pct<5)return 10; if(pct<10)return 8; if(pct<15)return 6; if(pct<20)return 4; if(pct<30)return 2; return 0; }
function scDiv(v){ if(v==null||isNaN(v)||v<2)return 0; if(v>=6)return 20; if(v>=5)return 12; if(v>=4)return 8; if(v>=3)return 4; return 2; }
function scNC(v){ if(v==null)return 0; if(v>=30)return 10; if(v>=20)return 8; if(v>=10)return 6; if(v>=0)return 4; return 2; }
function scAt(a){ if(a==='央企')return 10; if(a==='地方国企')return 8; if(a==='民营'||a==='集体'||a==='外资')return 6; return 0; }
function scRo(v){ if(v==null)return 0; if(v>=25)return 10; if(v>=20)return 8; if(v>=15)return 6; if(v>=10)return 4; if(v>=0)return 2; return 0; }
function scPa(v){ if(v==null)return 0; if(v>=80)return 10; if(v>=60)return 8; if(v>=40)return 6; if(v>=20)return 4; return 2; }
// 保险股 PEV 分档（绝对阈值，与 build_dist.js 一致）
function scPEV(v){ if(v==null)return 0; if(v<0.55)return 10; if(v<0.65)return 8; if(v<0.75)return 6; if(v<0.9)return 4; if(v<1.15)return 2; return 0; }
function scClass(v){
  // 把分数映射到 CSS class
  if(v==null||v===0) return 'sc0';
  if(v>=10) return 'sc10';
  if(v===8) return 'sc8';
  if(v===6) return 'sc6';
  if(v===4) return 'sc4';
  if(v===20) return 'sc20';
  if(v===12) return 'sc12';
  if(v===2) return 'sc2';
  return 'sc0';
}

// ----- 加载静态数据 -----
const NAME_IDX_KEY = 'szcq_nameidx_v1';
async function loadIndex(){
  // 1) 先用 localStorage 缓存（如有），保证搜索框立即可用、二次打开秒开
  try {
    const cached = localStorage.getItem(NAME_IDX_KEY);
    if(cached){ nameIdx = JSON.parse(cached); }
  } catch(e){ /* ignore */ }
  // 2) 后台拉最新版本，成功则更新缓存并刷新当前搜索结果
  try {
    const idx = await fetch(dataUrl('name_index.json'), { cache:'no-cache' }).then(r=>{
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    });
    nameIdx = idx;
    try { localStorage.setItem(NAME_IDX_KEY, JSON.stringify(idx)); } catch(e){ /* 容量超限忽略 */ }
    const input = document.getElementById('q');
    if(input && input.value.trim()) doSearch(input.value);
  } catch(e){
    console.warn('name_index 更新失败，使用缓存/快照：', e.message);
  }
}

let boardSlice = 0;          // 已渲染到第几条
const BOARD_PAGE = 120;      // 每批渲染数量
async function loadBoard(){
  const top = await fetch(dataUrl('ranking.json')).then(r=>r.json());
  rankTop = top;
  if(rankTop.length) rankTop.sort((a,b)=>a.rank-b.rank); // 严格按排名升序，便于定位
  renderBoard();
}

function renderBoard(){
  const root = document.getElementById('board-top10');
  if(!root) return;
  root.innerHTML = '';
  boardSlice = 0;
  if(!rankTop.length){ root.innerHTML = '<div class="board-loading">加载中...</div>'; return; }
  renderMore(BOARD_PAGE);
}

// 增量渲染：默认再渲染一页；传 upTo 则渲染到指定序号（含）
function renderMore(upTo){
  const root = document.getElementById('board-top10');
  if(!root || !rankTop.length) return;
  const target = (upTo != null) ? upTo : (boardSlice + BOARD_PAGE);
  const frag = document.createDocumentFragment();
  while(boardSlice < target && boardSlice < rankTop.length){
    const e = rankTop[boardSlice];
    const card = document.createElement('div');
    card.className = 'board-card';
    card.id = 'bc-' + e.rank;
    card.innerHTML = `
      <div class="row1">
        <span><span class="rank">#${e.rank}</span> <span class="name">${e.name}</span> <span class="meta" style="font-size:11px;color:var(--muted)">${e.code}</span></span>
        <span class="total">${e.total}</span>
      </div>
      <div class="props">
        <div class="prop"><span class="label">企业属性</span><span>${e.soe}</span></div>
        <div class="prop"><span class="label">PE分位 <span class="pill ${scClass(e.peSc)}">${e.peSc}</span></span><span>${e.pePct!=null?e.pePct.toFixed(1)+'%':'-'}</span></div>
        <div class="prop"><span class="label">PB分位 <span class="pill ${scClass(e.pbSc)}">${e.pbSc}</span></span><span>${e.pbPct!=null?e.pbPct.toFixed(1)+'%':'-'}</span></div>
        <div class="prop"><span class="label">股息率 <span class="pill ${scClass(e.divSc)}">${e.divSc}</span></span><span>${e.divY!=null?e.divY.toFixed(2)+'%':'-'}</span></div>
        <div class="prop"><span class="label">净现金 <span class="pill ${scClass(e.ncSc)}">${e.ncSc}</span></span><span>${e.nc!=null?e.nc.toFixed(1)+'%':'-'}</span></div>
        <div class="prop"><span class="label">ROCE <span class="pill ${scClass(e.roSc)}">${e.roSc}</span></span><span>${e.roce!=null?e.roce.toFixed(1)+'%':'-'}</span></div>
        <div class="prop"><span class="label">派息率 <span class="pill ${scClass(e.paSc)}">${e.paSc}</span></span><span>${e.pay!=null?e.pay.toFixed(1)+'%':'-'}</span></div>
        <div class="prop"><span class="label">盈利质量 <span class="pill ${scClass(e.cfSc!=null?e.cfSc:0)}">${e.cfNA?'—':(e.cfSc!=null?e.cfSc:0)}</span></span><span>${e.cfNA?'不适用':(e.cfComposite!=null?(e.cfComposite*100).toFixed(0)+'%':'-')}</span></div>
      </div>
    `;
    card.onclick = () => selectCode(e.code);
    frag.appendChild(card);
    boardSlice++;
  }
  root.appendChild(frag);
}

// 滚动到底自动加载更多
function onBoardScroll(){
  const root = document.getElementById('board-top10');
  if(!root) return;
  if(root.scrollTop + root.clientHeight >= root.scrollHeight - 160){
    renderMore();
  }
}

// 标题输入框：输入排名数字 → 滚动定位并高亮
function attachBoardJump(){
  const input = document.getElementById('board-jump');
  if(!input) return;
  let timer = null;
  const go = (immediate) => {
    const v = parseInt(input.value.trim(), 10);
    if(isNaN(v) || v < 1 || v > RANK_MAX){
      input.classList.add('bad');
      return;
    }
    input.classList.remove('bad');
    if(v - 1 >= boardSlice) renderMore(v);   // 确保该排名已渲染
    const el = document.getElementById('bc-' + v);
    if(el){
      el.scrollIntoView({ block:'center', behavior: immediate ? 'smooth' : 'auto' });
      el.classList.remove('jump-hl'); void el.offsetWidth; el.classList.add('jump-hl');
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(()=>go(false), 250); });
  input.addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); clearTimeout(timer); go(true); } });
}

// ----- 搜索 -----
function doSearch(raw){
  const resultsBox = document.getElementById('search-results');
  const q = (raw||'').trim().toLowerCase();
  const rawQ = (raw||'').trim();
  if(!q){ resultsBox.innerHTML=''; return; }
  if(!nameIdx.length){
    resultsBox.innerHTML = '<div class="search-results"><div class="sr" style="color:var(--muted)">股票列表加载中…请稍候</div></div>';
    return;
  }
  // 精确匹配（代码或名称完全一致）→ 直接选中，免点击
  const exact = nameIdx.find(x => x.c.toLowerCase()===q || x.n===rawQ);
  if(exact){
    resultsBox.innerHTML='';
    selectCode(exact.c);
    document.getElementById('q').value = exact.n;
    return;
  }
  const matches = nameIdx.filter(x => x.c.toLowerCase().includes(q) || x.n.includes(q)).slice(0, 12);
  if(!matches.length){
    resultsBox.innerHTML = '<div class="search-results"><div class="sr" style="color:var(--muted)">无匹配结果</div></div>';
    return;
  }
  resultsBox.innerHTML = '<div class="search-results">' +
    matches.map(m => `<div class="sr" data-code="${m.c}"><strong>${m.n}</strong><span class="code">${m.c.toUpperCase()}</span></div>`).join('') +
    '</div>';
  resultsBox.querySelectorAll('.sr').forEach(el => {
    el.onclick = () => { resultsBox.innerHTML=''; selectCode(el.dataset.code); document.getElementById('q').value=''; };
  });
}
function attachSearch(){
  const input = document.getElementById('q');
  const resultsBox = document.getElementById('search-results');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => doSearch(input.value), 150);
  });
  input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){
      const q = input.value.trim();
      if(!q) return;
      const m = nameIdx.find(x => x.c.toLowerCase()===q.toLowerCase() || x.n===q)
              || nameIdx.find(x => x.c.toLowerCase().includes(q.toLowerCase()) || x.n.includes(q));
      if(m){ resultsBox.innerHTML=''; selectCode(m.c); input.value = m.n; }
    }
  });
  input.addEventListener('blur', () => setTimeout(()=>resultsBox.innerHTML='', 200));
}

// ----- 按排名搜索 -----
const RANK_IDX_KEY = 'szcq_rankidx_v1';
const RANK_MAX = 5002;
async function loadRankList(){
  if(rankList.length) return rankList;
  try {
    const cached = localStorage.getItem(RANK_IDX_KEY);
    if(cached){ const a = JSON.parse(cached); if(Array.isArray(a) && a.length){ rankList = a; return rankList; } }
  } catch(e){ /* ignore */ }
  // 懒加载全市场排名（首次使用排名框时）；精简存储以节省 localStorage 空间
  const all = await fetch(dataUrl('all.json'), { cache:'no-cache' }).then(r=>{
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  });
  rankList = all.map(x => ({ rank:x.rank, code:x.code, name:x.name, total:x.total }));
  try { localStorage.setItem(RANK_IDX_KEY, JSON.stringify(rankList)); } catch(e){ /* 容量超限忽略 */ }
  return rankList;
}
function pickByRank(code, name){
  selectCode(code);
  document.getElementById('q').value = name;
  const rq = document.getElementById('rank-q');
  if(rq) rq.blur();
}
function attachRankSearch(){
  const input = document.getElementById('rank-q');
  const box = document.getElementById('rank-result');
  if(!input || !box) return;
  let timer = null;
  const render = async (pick) => {
    const raw = input.value.trim();
    const v = parseInt(raw, 10);
    if(!raw){ box.innerHTML=''; return; }
    if(isNaN(v) || v < 1 || v > RANK_MAX){ box.innerHTML = '<span class="rank-tip" style="cursor:default">排名范围 1 – '+RANK_MAX+'</span>'; return; }
    try {
      await loadRankList();
    } catch(e){
      box.innerHTML = '<span class="rank-tip" style="cursor:default;color:#ad6800">排名数据加载失败，请重试</span>';
      return;
    }
    const it = rankList.find(x => x.rank === v);
    if(!it){ box.innerHTML = '<span class="rank-tip" style="cursor:default">该排名暂无数据</span>'; return; }
    box.innerHTML = `<span class="rank-tip" data-code="${it.code}" data-name="${it.name}">第 ${it.rank} 名 · <strong>${it.name}</strong> <span class="code">${it.code.toUpperCase()}</span> · 总分 ${it.total} <span class="go">↵ 查看详情</span></span>`;
    const tip = box.querySelector('.rank-tip');
    if(tip && !pick) tip.onclick = () => pickByRank(it.code, it.name);
    if(pick) pickByRank(it.code, it.name);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(()=>render(false), 200); });
  input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); clearTimeout(timer); render(true); }
  });
  input.addEventListener('blur', () => setTimeout(()=>{ box.innerHTML=''; }, 300));
}

// ----- 选中公司 -----
async function fetchKline(code){
  const today = new Date().toISOString().slice(0,10);
  const shift = (y,m)=>{ const d=new Date(); d.setFullYear(d.getFullYear()-y); d.setMonth(d.getMonth()-m); return d.toISOString().slice(0,10); };
  const defs = {
    daily:   { period:'day',   start: shift(0,3), count:120, key:'qfqday' },
    weekly:  { period:'week',  start: shift(1,0), count:60,  key:'qfqweek' },
    monthly: { period:'month', start: shift(5,0), count:60,  key:'qfqmonth' }
  };
  const out = { daily:[], weekly:[], monthly:[] };
  await Promise.all(Object.keys(defs).map(async (p) => {
    const d = defs[p];
    try {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${d.period},${d.start},${today},${d.count},qfq`;
      const r = await fetch(url, { cache:'no-cache' });
      const j = await r.json();
      const arr = j && j.data && j.data[code] && j.data[code][d.key];
      if(Array.isArray(arr)){
        out[p] = arr.map(it => Array.isArray(it)
          ? [it[0], +it[1], +it[2], +it[3], +it[4], +it[5]]
          : [it.date, +it.open, +it.close, +it.high, +it.low, +it.volume]);
      }
    } catch(e){ /* 留空，降级为“暂无数据” */ }
  }));
  return out;
}
async function selectCode(code){
  currentCode = code;
  // 先把各面板显示出来（骨架）
  ['score-panel','kline-panel','qchart-panel','plan-panel','ir-panel','blemish-panel'].forEach(id=>{
    document.getElementById(id).style.display = '';
  });
  let data;
  try {
    const bucketKey = String(parseInt(code.slice(-2),10) % 64).padStart(2,'0');
    const bkObj = await fetchGz(dataUrl('data/b/'+bucketKey+'.json.gz'));
    data = bkObj[code] || null;
    if(!data) throw new Error('未找到该股票数据');
    currentData = data;
    // K线改为详情页实时拉腾讯（部署分桶不再烘焙 K线，体积过大导致上传 504）
    if(!currentData.kline){
      try { currentData.kline = await fetchKline(code); }
      catch(e){ currentData.kline = { daily:[], weekly:[], monthly:[] }; }
    }
  } catch(e){
    console.warn('selectCode 数据加载失败:', e.message);
    const g = document.getElementById('score-grid');
    if(g) g.innerHTML = '<div class="empty-tip">数据加载失败：' + e.message + '（请重试）</div>';
    const t = document.getElementById('score-total');
    if(t) t.textContent = '-';
    return;
  }
  // 各渲染相互独立：任一失败都不影响其它（评分必须显示）
  safeRender('评分', renderScore);
  safeRender('K线', () => renderKline(data));
  safeRender('季度', () => renderQChart(data));
  safeRender('股东回报', () => renderPlan(data));
  safeRender('IR', () => renderIR(data));
  safeRender('污点', () => renderBlemish(data));
  // 若该公司在标记框，选中/搜索时自动提到标记框第一行，方便定位
  if(WS.isWatched(currentCode)){
    WS.promoteWatch(currentCode);
    renderWatch();
  }
  refreshPrice();
}
function safeRender(label, fn){
  try { fn(); }
  catch(e){ console.warn(label + ' 渲染失败:', e.message); }
}

// 公开的全局函数供刷新按钮用
window.__refreshPrice = refreshPrice;

async function refreshPrice(){
  if(!currentCode) return;
  // 腾讯行情公共接口：直接返回 JS 变量 v_sh600160="..."; 不支持 JSONP callback
  // 因此直接加载 script，然后在 window 上读取该变量
  const code = currentCode.toLowerCase();
  const url = `https://qt.gtimg.cn/q=${code}`;
  const varName = `v_${code}`;
  // 解析腾讯返回串（v_xxx="1~名称~代码~现价~昨收~今开~..."）取第 4 段=现价
  function parseQuote(str){
    const m = String(str).match(/="([^"]+)"/);
    if(!m) return null;
    const parts = m[1].split('~');
    const price = parseFloat(parts[3]);
    return (price && price > 0) ? price : null;
  }
  // 方式一：script 注入（部分广告/隐私插件会拦截外部脚本）
  try {
    const data = await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => {
        const v = window[varName];
        if(v == null) reject(new Error('quote var not found'));
        else resolve(String(v));
        try{ document.head.removeChild(s); }catch(e){}
      };
      s.onerror = () => { try{ document.head.removeChild(s); }catch(e){} reject(new Error('script load failed')); };
      document.head.appendChild(s);
      setTimeout(() => { try{ document.head.removeChild(s); }catch(e){} reject(new Error('timeout')); }, 5000);
    });
    const price = parseQuote(data);
    if(!price) throw new Error('parse fail');
    livePrice[currentCode] = price;
    if(currentData){ renderScore(price); renderKline(currentData, price); }
    return;
  } catch(e){
    console.warn('refresh price (script) failed:', e.message);
  }
  // 方式二：fetch 直连兜底（腾讯接口已开 CORS *，可绕过脚本拦截）
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const txt = await res.text();
    const price = parseQuote(txt);
    if(!price) throw new Error('parse fail');
    livePrice[currentCode] = price;
    if(currentData){ renderScore(price); renderKline(currentData, price); }
    return;
  } catch(e2){
    console.warn('refresh price (fetch) failed:', e2.message);
  }
  // 两种方式都失败：用日K收盘价兜底渲染一次，并稍后重试
  if(currentData) renderScore();
  setTimeout(refreshPrice, 8000);
}

function renderScore(realtime){
  const d = currentData;
  if(!d) return;
  // 实时价回退：优先传入的实时价 / 缓存实时价 / 最新日K收盘价
  // 注意：日K数组可能为倒序（最新在前），这里按日期取“最大日期”那条，避免回退到最旧价
  const dailyCloseArr = (d.kline && d.kline.daily) || [];
  let lastClose = null;
  if(dailyCloseArr.length){
    let best = dailyCloseArr[0];
    for(const it of dailyCloseArr){ if(it[0] > best[0]) best = it; }
    lastClose = best[1];
  }
  const price = realtime ?? livePrice[currentCode] ?? lastClose;
  // 实时价元数据
  const meta = document.getElementById('meta-line');
  if(document.getElementById('score-panel').style.display === 'none'){
    document.getElementById('score-panel').style.display = '';
  }
  const validPrice = (typeof price === 'number' && !isNaN(price)) ? price : null;
  const mcap = (d.shares && validPrice) ? validPrice * d.shares / 1e8 : null; // 亿元
  document.getElementById('score-title').textContent = `${d.name}（${d.code}）评分`;
  const __db = document.getElementById('deep-btn');
  if(__db) __db.style.display = deepHas(d.code) ? '' : 'none';
  updateStar();
  document.getElementById('score-meta').innerHTML = `
    实时价 <span class="liveprice">¥${validPrice!=null?validPrice.toFixed(2):'-'}</span> · 总市值 ${mcap!=null?mcap.toFixed(0)+'亿元':'-'} · 企业属性 ${d.soe}
  `;
  // 评分可信度：标记缺失的“硬因子”（缺失则该因子未计分）
  const hardFactors = [
    ['histPE','PE历史'],['histPB','PB历史'],['avgRoce','ROCE'],
    ['avgPayout','派息比例'],['annualDps','股息率'],['netCashRatio','净现金率']
  ];
  const hardMiss = hardFactors
    .filter(([k]) => d[k] == null || d[k] === '' || (Array.isArray(d[k]) && !d[k].length))
    .map(([,label]) => label);
  const credEl = document.getElementById('score-cred');
  if(hardMiss.length){
    credEl.style.display = '';
    credEl.innerHTML = '⚠ 数据缺失：' + hardMiss.join('、') + '，对应因子未计分，评分仅供参考';
  } else if(d.cfComposite == null && !d.cfNA){
    credEl.style.display = '';
    credEl.innerHTML = '⚠ 现金流/财务数据不足 3 个完整年度，「盈利质量」因子记 0 分';
  } else if(d.ttmEps == null){
    credEl.style.display = '';
    credEl.innerHTML = '⚠ 缺少 TTM EPS，PE 采用烘焙静态值（非实时），其余因子正常';
  } else {
    credEl.style.display = 'none';
  }
  // 用实时价重新计算 - 实时 PE/PB/股息率 都是用实时价
  let snapPE=d.snapPE, snapPB=d.snapPB, snapDiv=d.snapDiv;
  if(validPrice && d.ttmEps>0) snapPE = validPrice/d.ttmEps;
  if(validPrice && d.bvps>0) snapPB = validPrice/d.bvps;
  if(validPrice && d.annualDps>0 && d.shares>0) {
    // 简化：实时股息率 ≈ annualDps / price（annualDps 已经是元/股）
    snapDiv = (d.annualDps / validPrice) * 100;
  }
  const pePct = percentile(snapPE, d.histPE);       // 归母TTM口径（仅对照）
  const pbPct = percentile(snapPB, d.histPB);
  const peScGross = scPE(pePct), pbScGross = scPE(pbPct);
  // ---- 前瞻口径：用实时价重算 前瞻扣非PE / 前瞻PB / 前瞻股息率（桶内 fwdEps/fwdBvps/fwdDpsEst + 前瞻口径历史）----
  let fwdPE = d.fwdPE, fwdPB = d.fwdPB, fwdPePct = d.fwdPePct, fwdPbPct = d.fwdPbPct, fwdDivYield = d.fwdDivYield;
  if(validPrice && d.fwdEps>0) fwdPE = validPrice/d.fwdEps;
  if(validPrice && d.fwdBvps>0) fwdPB = validPrice/d.fwdBvps;
  if(validPrice && d.fwdDpsEst>0) fwdDivYield = d.fwdDpsEst/validPrice*100;
  if(d.fwdHP && d.fwdHP.length>=6 && fwdPE!=null) fwdPePct = percentile(fwdPE, d.fwdHP);
  if(d.fwdHPB && d.fwdHPB.length>=6 && fwdPB!=null) fwdPbPct = percentile(fwdPB, d.fwdHPB);
  let peSc, peBasis;
  if(d.fwdEps!=null && d.fwdEps<=0){ peSc=0; peBasis='前瞻扣非亏损(不给估值分)'; }
  else if(fwdPE!=null && fwdPE>100){ peSc=0; peBasis='前瞻PE极高(不给估值分)'; }
  else if(fwdPePct!=null && d.fwdHP && d.fwdHP.length>=12){ peSc=scPE(fwdPePct); peBasis='前瞻扣非PE'; }
  else if(d.dedEps!=null && d.dedEps<=0){ peSc=0; peBasis='扣非亏损(不给估值分)'; }
  else if(d.dedPePct!=null && d.dedHP && d.dedHP.length>=12){ peSc=scPE(d.dedPePct); peBasis='扣非TTM PE(前瞻历史不足)'; }
  else { peSc=peScGross; peBasis='归母PE(数据不足)'; }
  let pbSc = (fwdPbPct!=null && d.fwdHPB && d.fwdHPB.length>=12) ? scPE(fwdPbPct) : pbScGross;
  // ---- 保险 / 券商 单独处理（与 build_dist.js 一致）----
  let pevLive = d.pev;
  if(d.nbType==='INS'){
    if(d.evYuan>0 && validPrice>0 && d.shares>0){ pevLive = validPrice*d.shares/d.evYuan; peSc = scPEV(pevLive); peBasis='保险·PEV'; }
    else { peSc = 4; peBasis='保险·无EV(中性)'; }
  } else if(d.nbType==='BROKER'){
    const pbBased = (fwdPbPct!=null && d.fwdHPB && d.fwdHPB.length>=12) ? scPE(fwdPbPct) : 4;
    peSc = pbBased; pbSc = pbBased; peBasis='券商·PB分位';
  }
  // ---- 前瞻股息率打分 + 可持续性折扣（① 分红透支扣非 ② 扣非同比明显为负）----
  const divScRaw = scDiv(fwdDivYield);
  const divCands = [];
  if(d.earnWarn===1 && d.divTotal!=null && d.dedTtm!=null && d.dedTtm>0 && d.divTotal > d.dedTtm) divCands.push(8);
  if(d.dedYoY!=null && d.dedYoY<=-0.30) divCands.push(8);
  else if(d.dedYoY!=null && d.dedYoY<=-0.15) divCands.push(12);
  let divSc = divScRaw, divSust = null;
  for(const cap of divCands){ if(cap < divSc) divSc = cap; if(cap < divScRaw) divSust = 0; }
  const ncSc = scNC(d.netCashRatio);
  const atSc = scAt(d.soe);
  const roSc = scRo(d.avgRoce);
  const paSc = scPa(d.avgPayout);
  const cfSc = d.cfSc || 0;   // 第8因子：盈利质量组合分（横截面排位，构建时算好，与实时价无关；金融股为中性分）
  const fwdSc = d.fwdSc || 0; // 第9因子：前瞻赋分（−10~+10；含扣非趋势/现金流校验）
  const total = peSc+pbSc+divSc+ncSc+atSc+roSc+paSc+cfSc+fwdSc;
  // 净现金口径明细（悬停提示）：货币资金 [+ 交易性金融资产] − 有息负债
  let ncTitle = '';
  if(d.ncCash!=null){
    ncTitle = '净现金 = 货币资金 '+d.ncCash+'亿'+(d.ncTrading?(' + 交易性金融资产 '+d.ncTrading+'亿'):'')+(d.cfNA?'（金融股不计交易性金融资产）':'')+' − 有息负债 '+(d.ncDebt!=null?d.ncDebt+'亿':'—');
    if(d.ncRatioCashOnly!=null){
      ncTitle += '；仅货币资金口径 = '+d.ncRatioCashOnly.toFixed(1)+'%';
      if(d.ncSensitive) ncTitle += '（⚠ 两口径相差 ≥15 个百分点：含较多类金融资产/金融子公司，数值请谨慎参考）';
    }
  }
  // ---- 估值口径提示（前瞻 vs TTM）----
  const gPE = 'TTM归母PE '+(snapPE!=null?snapPE.toFixed(2):'—')+(pePct!=null?'（分位 '+pePct.toFixed(1)+'%）':'');
  const fwdPEtxt = '前瞻扣非PE '+(fwdPE!=null?fwdPE.toFixed(2):'—')+(fwdPePct!=null?'（分位 '+fwdPePct.toFixed(1)+'%）':'');
  let peTitle, peLabel;
  if(d.fwdEps!=null && d.fwdEps<=0){ peLabel='前瞻估值'; peTitle='预估全年扣非亏损，无法估值，本项记 0；对照 '+gPE; }
  else if(fwdPE!=null && fwdPE>100){ peLabel='前瞻估值'; peTitle='前瞻扣非PE 过高（预估扣非盈利极薄），本项记 0；对照 '+gPE; }
  else if(peBasis.indexOf('前瞻')===0){
    peLabel='前瞻扣非PE';
    const est = (d.fwdEstNp!=null) ? ('预估全年归母 '+d.fwdEstNp+' 亿（按去年同期节奏外推）、去年派息率 '+(d.fwdPayout!=null?d.fwdPayout.toFixed(0)+'%':'—')) : '';
    peTitle='以「前瞻扣非PE」为准——用当年季度利润外推全年利润：'+fwdPEtxt+'；'+est+(d.dedRatioTtm!=null?('；扣非/归母TTM='+d.dedRatioTtm.toFixed(2)):'');
  } else { peLabel='PE 分位'; peTitle='前瞻数据不足，回退其他口径；'+gPE; }
  const pbTitle = '前瞻PB '+(fwdPB!=null?fwdPB.toFixed(2):'—')+(fwdPbPct!=null?'（分位 '+fwdPbPct.toFixed(1)+'%）':'')+'（净资产 = 最新净资产 + 预估剩余利润）'
    +'；对照 TTM PB '+(snapPB!=null?snapPB.toFixed(2):'—')+(pbPct!=null?'（分位 '+pbPct.toFixed(1)+'%）':'');
  const peShown = (fwdPE!=null && d.fwdEps>0) ? fwdPE : snapPE;
  const pePctShown = (fwdPePct!=null && d.fwdHP && d.fwdHP.length>=12) ? fwdPePct : pePct;
  const pbShown = (fwdPB!=null && d.fwdBvps>0) ? fwdPB : snapPB;
  const pbPctShown = (fwdPbPct!=null && d.fwdHPB && d.fwdHPB.length>=12) ? fwdPbPct : pbPct;
  const fwdDivShown = (d.fwdDpsEst>0 && validPrice>0) ? (d.fwdDpsEst/validPrice*100) : d.fwdDivYield;
  // ---- 前瞻股息率可信度预警（与 build_dist.js 同规则，用实时价口径）----
  //   提示"这个前瞻股息率有问题"的具体原因，供悬停查看
  const dwR = [];
  if (fwdDivShown != null && fwdDivShown >= 10)
    dwR.push(`前瞻股息率 ${fwdDivShown.toFixed(1)}% 显著高于 A 股常态（正常不足 8%）：高股息率通常来自股价大幅下跌，或利润含一次性/非现金收益（如资产处置、公允价值变动），请核实利润来源与可持续性`);
  if (d.earnWarn === 1 && fwdDivShown != null && fwdDivShown >= 6)
    dwR.push('支撑该股息率的利润含大额非经常性损益（扣非/归母低于 0.6），股息基础不牢，可能无法持续');
  if (snapDiv != null && snapDiv > 0 && fwdDivShown != null && fwdDivShown >= 2.5 * snapDiv && fwdDivShown >= 8)
    dwR.push(`前瞻股息率是 TTM 股息率（${snapDiv.toFixed(2)}%）的 ${(fwdDivShown / snapDiv).toFixed(1)} 倍，主要由「利润外推」假设贡献；若全年利润不达预期，股息会同步缩水`);
  const divFwdWarn = dwR.length ? 1 : null;
  const divFwdReason = dwR.length ? dwR.join('；') : null;
  // 点击红色标记时弹出说明所需的数据快照
  __divWarnCtx = { name: d.name, code: d.code, fwdDiv: fwdDivShown, trailDiv: snapDiv, estNp: d.fwdEstNp, payout: d.fwdPayout, dedRatio: d.dedRatioTtm, reasons: dwR };
  // ---- 保险 / 券商 展示覆盖 ----
  let peLabel2 = peLabel, peTitle2 = peTitle, peShown2 = peShown, pePctShown2 = pePctShown;
  if(d.nbType==='INS'){
    peLabel2 = '保险·PEV'; peShown2 = pevLive; pePctShown2 = null;
    peTitle2 = '保险股以 PEV = 市值 ÷ 内含价值 估值（PE 不适用）。当前 PEV ' + (pevLive!=null?pevLive.toFixed(2):'—')
      + '，分档：<0.55→10 / <0.65→8 / <0.75→6 / <0.9→4 / <1.15→2 / ≥1.15→0。' + (d.nbNote||'');
  } else if(d.nbType==='BROKER'){
    peLabel2 = '券商·PB分位'; peShown2 = pbShown; pePctShown2 = pbPctShown;
    peTitle2 = '券商/期货盈利强周期，PE 在周期顶/底会反向失真，故估值以 PB 为准（两个估值槽均取前瞻PB分位）。' + (d.nbNote||'');
  }

  // ---- 近一年最低点（用日K最低收盘价近似；daily 为 [date, close]，约 241 个交易日≈1年）----
  let lowYear = null, lowYearDate = null;
  const dailyArr = (d.kline && d.kline.daily) || [];
  if(dailyArr.length){
    for(const it of dailyArr){
      const c = Array.isArray(it) ? it[1] : (it.close!=null ? it.close : null);
      const dt = Array.isArray(it) ? it[0] : (it.date!=null ? it.date : null);
      if(c==null) continue;
      if(lowYear==null || c < lowYear){ lowYear = c; lowYearDate = dt; }
    }
  }
  // 现价比近一年最低点高出多少；最低点(≈0)则提示"当前股价为一年内最低点"
  let lowGapTxt = '-', lowGapPct = null;
  if(validPrice!=null && lowYear!=null && lowYear > 0){
    lowGapPct = (validPrice - lowYear) / lowYear * 100;
    if(Math.abs(lowGapPct) < 0.5){
      lowGapTxt = `当前为一年内最低点（¥${lowYear.toFixed(2)}）`;
    } else {
      lowGapTxt = `高于最低点 ${lowGapPct.toFixed(1)}%（最低 ¥${lowYear.toFixed(2)}${lowYearDate?' / '+lowYearDate:''}）`;
    }
  }

  document.getElementById('score-grid').innerHTML = `
    <div class="score-row"><span class="name">估值 · ${peLabel2}<span class="cf-hint" title="${peTitle2}">?</span></span><span class="val">${peShown2!=null?peShown2.toFixed(2):'-'}${pePctShown2!=null?' ('+pePctShown2.toFixed(1)+'%)':''}</span><span class="pill ${scClass(peSc)}">${peSc}</span></div>
    <div class="score-row"><span class="name">前瞻PB<span class="cf-hint" title="${pbTitle}">?</span></span><span class="val">${pbShown!=null?pbShown.toFixed(2):'-'} (${pbPctShown!=null?pbPctShown.toFixed(1)+'%':'-'})</span><span class="pill ${scClass(pbSc)}">${pbSc}</span></div>
    <div class="score-row"><span class="name">前瞻股息率<span class="cf-hint" title="前瞻股息率 = 预估全年归母 × 去年派息率 ÷ 市值（对照：TTM 股息率 ${snapDiv!=null?snapDiv.toFixed(2)+'%':'—'}）">?</span>${divFwdWarn?('<span class="cf-hint warn" title="点击查看前瞻股息率可信度说明" onclick="openDivWarn()">!</span>'):''}${divSust===0?('<span class="cf-hint" title="⚠ 已打折：'+(d.divReason||'扣非利润下滑或分红透支').replace(/"/g,'')+'">!</span>'):''}</span><span class="val">${fwdDivShown!=null?fwdDivShown.toFixed(2)+'%':'-'}${(divSust===0||divFwdWarn)?' ⚠':''}</span><span class="pill ${scClass(divSc)}">${divSc}</span></div>
    <div class="score-row"><span class="name">净现金 / 市值</span><span class="val"${ncTitle?' title="'+ncTitle+'"':''}>${d.netCashRatio!=null?d.netCashRatio.toFixed(2)+'%':'-'}</span><span class="pill ${scClass(ncSc)}">${ncSc}</span></div>
    <div class="score-row"><span class="name">企业属性</span><span class="val">${d.soe||'-'}</span><span class="pill ${scClass(atSc)}">${atSc}</span></div>
    <div class="score-row"><span class="name">近 4 年平均 ROCE</span><span class="val">${d.avgRoce!=null?d.avgRoce.toFixed(2)+'%':'-'}</span><span class="pill ${scClass(roSc)}">${roSc}</span></div>
    <div class="score-row"><span class="name">近 4 年平均派息比例</span><span class="val">${d.avgPayout!=null?d.avgPayout.toFixed(2)+'%':'-'}</span><span class="pill ${scClass(paSc)}">${paSc}</span></div>
    <div class="score-row"><span class="name">盈利质量<span class="cf-hint" title="近3个完整年度合计的三项组合：现金含量(Σ经营现金流÷Σ扣非净利)权重40% + 收现比(Σ销售商品收到现金÷Σ营业收入)权重40% + 应计质量(Σ(归母净利−经营现金流)÷Σ总资产)权重20%；各子项先转全市场横截面百分位再加权，最后按排位给分：前10%→10 / 10~25%→8 / 25~40%→6 / 40~60%→4 / 60~80%→2 / 后20%→0。用多年合计可抑制单期波动与财务公司失真。">?</span></span><span class="val"${d.cfComposite!=null?' title="现金含量 '+(d.cfCash!=null?d.cfCash.toFixed(2)+'×':'—')+' · 收现比 '+(d.cfCollect!=null?d.cfCollect.toFixed(2):'—')+' · 应计质量 '+(d.cfAccrual!=null?d.cfAccrual.toFixed(3):'—')+'（越低越好）"':''}>${d.cfNA?'不适用':(d.cfComposite!=null?(d.cfComposite*100).toFixed(0)+'%':'-')}</span><span class="pill ${scClass(cfSc)}"${d.cfNA?' title="金融股该指标口径不适用，按中性计分"':''}>${d.cfNA?'—':cfSc}</span></div>
    <div class="score-row"><span class="name">前瞻赋分<span class="cf-hint" title="${fwdTip(d)}">?</span></span><span class="val">${d.fwdGrp||'-'}</span><span class="pill ${fwdClass(fwdSc)}">${fwdSc>0?'+':''}${fwdSc}</span></div>
    <div class="score-row hl"><span class="name">现价比一年最低点</span><span class="val">${lowGapTxt}</span></div>
  `;
  document.getElementById('score-total').textContent = total;
}

// ----- K 线图 -----
function renderKline(data, price){
  document.querySelectorAll('.kline-tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.kline-tabs button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      currentKPeriod = b.dataset.period;
      drawKline(data.kline[currentKPeriod] || [], price);
    };
  });
  drawKline(data.kline[currentKPeriod] || [], price);
}
function drawKline(arr, price){
  const svg = document.getElementById('kline-svg');
  const W = 800, H = 240, PAD = { l: 40, r: 80, t: 10, b: 24 }; // 右侧留 80px 空白槽放橙色实时价标签，避免压住 K 线
  svg.innerHTML = '';
  if(!arr || !arr.length){ svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#888" font-size="12">暂无${currentKPeriod === 'daily' ? '日' : currentKPeriod === 'weekly' ? '周' : '月'}K线数据</text>`; return; }
  // 归一化：保证按时间升序（最旧在左、最新在右），兼容日/周/月三种源顺序
  const d0 = Array.isArray(arr[0]) ? arr[0][0] : (arr[0] ? arr[0].date : '');
  const dN = Array.isArray(arr[arr.length-1]) ? arr[arr.length-1][0] : (arr[arr.length-1] ? arr[arr.length-1].date : '');
  if(d0 > dN) arr = arr.slice().reverse();
  const closes = arr.map(k => Array.isArray(k) ? k[1] : k.close);
  // 纵轴范围纳入实时价，保证“实时价标记线”始终可见
  const vals = closes.slice();
  if(typeof price === 'number' && !isNaN(price)) vals.push(price);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;
  const stepX = arr.length > 1 ? chartW / (arr.length - 1) : 0;
  // 网格 + y 轴
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++){
    const y = PAD.t + chartH * i / gridLines;
    const val = max - range * i / gridLines;
    svg.insertAdjacentHTML('beforeend', `<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${y}" y2="${y}" stroke="#eef0f3"/>`);
    svg.insertAdjacentHTML('beforeend', `<text x="${PAD.l-4}" y="${y+3}" text-anchor="end" fill="#999" font-size="10">${val.toFixed(1)}</text>`);
  }
  // x 轴标签（等距 5 个）；首标左对齐、末标右对齐，避免被画布边缘裁切
  const xTicks = Math.min(arr.length, 5);
  for (let i = 0; i < xTicks; i++){
    const idx = Math.min(arr.length - 1, Math.floor(arr.length * i / Math.max(1, xTicks - 1)));
    const x = PAD.l + (arr.length > 1 ? stepX * idx : 0);
    const kk = arr[idx]; const d = (kk && Array.isArray(kk)) ? kk[0] : (kk ? kk.date : '');
    const label = currentKPeriod === 'monthly' ? d.substring(0,7) : d.substring(5);
    let anchor = 'middle', lx = x;
    if(i === 0){ anchor = 'start'; lx = PAD.l; }
    else if(i === xTicks - 1){ anchor = 'end'; lx = W - PAD.r; }
    svg.insertAdjacentHTML('beforeend', `<text x="${lx}" y="${H - 4}" text-anchor="${anchor}" fill="#999" font-size="10">${label}</text>`);
  }
  // 折线
  let pathD = '';
  arr.forEach((k, i) => {
    const close = Array.isArray(k) ? k[1] : k.close;
    const x = PAD.l + (arr.length > 1 ? stepX * i : chartW / 2);
    const y = PAD.t + chartH - ((close - min) / range) * chartH;
    pathD += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  });
  // area
  const lastX = PAD.l + (arr.length > 1 ? stepX * (arr.length - 1) : chartW / 2);
  svg.insertAdjacentHTML('beforeend', `
    <defs><linearGradient id="ka" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b6ff0" stop-opacity=".3"/><stop offset="100%" stop-color="#3b6ff0" stop-opacity="0"/></linearGradient></defs>
    <path d="${pathD} L${lastX},${H-PAD.b} L${PAD.l},${H-PAD.b} Z" fill="url(#ka)"/>
    <path d="${pathD}" fill="none" stroke="#3b6ff0" stroke-width="1.5"/>
  `);
  // 实时价标记线（独立于 K 线：橙色虚线横贯图表 + 右侧独立标签，不与蓝色 K 线混在一起）
  if(typeof price === 'number' && !isNaN(price)){
    let yP = PAD.t + chartH - ((price - min) / range) * chartH;
    yP = Math.max(PAD.t, Math.min(H - PAD.b, yP)); // 夹在绘图区内
    svg.insertAdjacentHTML('beforeend', `<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${yP}" y2="${yP}" stroke="#ff7a00" stroke-width="1.2" stroke-dasharray="5 3"/>`);
    // 右侧空白槽内的独立小标签（带底框，起始 x 落在绘图区右边界之外，整体置于右侧空白槽内，绝不压住 K 线）
    const tagW = 72, tagH = 16, tagX = W - PAD.r + 4;
    const tagY = Math.max(PAD.t, Math.min(H - PAD.b - tagH, yP - tagH/2));
    svg.insertAdjacentHTML('beforeend', `<rect x="${tagX}" y="${tagY}" width="${tagW}" height="${tagH}" rx="3" fill="#ff7a00"/>`);
    svg.insertAdjacentHTML('beforeend', `<text x="${tagX + tagW/2}" y="${tagY + 11}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">实时 ¥${price.toFixed(2)}</text>`);
  }
  // 第一个点 + 最后一个点（仅作 K 线端点节点标记，不显示蓝色价格数字）
  const fy = arr.length > 1 ? PAD.t + chartH - ((closes[0] - min) / range) * chartH : PAD.t + chartH / 2;
  const ly = PAD.t + chartH - ((closes[closes.length - 1] - min) / range) * chartH;
  svg.insertAdjacentHTML('beforeend', `<circle cx="${PAD.l}" cy="${fy}" r="3" fill="#fff" stroke="#3b6ff0"/>`);
  svg.insertAdjacentHTML('beforeend', `<circle cx="${lastX}" cy="${ly}" r="3" fill="#3b6ff0"/>`);
}

// ----- 季度图表 -----
function renderQChart(data){
  document.querySelectorAll('.qchart-tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.qchart-tabs button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      currentMetric = b.dataset.metric;
      drawQChart(data.quarterly);
    };
  });
  drawQChart(data.quarterly);
}
function drawQChart(quarters){
  const svg = document.getElementById('qchart-svg');
  svg.innerHTML = '';
  if(!quarters || !quarters.length){ svg.innerHTML = `<text x="400" y="120" text-anchor="middle" fill="#888" font-size="12">暂无单季度数据</text>`; return; }
  // 选近 4 年 + 今年 Q1
  const thisYear = new Date().getFullYear();
  const years = [];
  // 包含今年如果有 Q1 数据（放在最右，作为最新一组）
  const cur = quarters.find(q => q.year === thisYear);
  const last4 = [thisYear-4, thisYear-3, thisYear-2, thisYear-1];
  for(const y of last4) if(quarters.find(q=>q.year===y)) years.push(y);
  if(cur) years.push(thisYear);   // 升序：最旧在左、最新在右
  if(!years.length) return;
  const data = years.map(y => quarters.find(q=>q.year===y)).filter(Boolean);
  // bars: 每年 4 个 (Q1..Q4) + 同比折线
  // metric
  const metricMap = { np: 'np', rev: 'rev', both: 'both' };
  const W = 800, H = 240, PAD = { l: 60, r: 30, t: 20, b: 36 };
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;
  // 收集数值
  const qCols = (m) => data.flatMap(d => ['Q1','Q2','Q3','Q4'].map(q => d[m]?.[q])).filter(v => v != null);
  const yoyCols = (m) => data.flatMap(d => ['Q1','Q2','Q3','Q4'].map(q => d[m+'YoY']?.[q])).filter(v => v != null);
  const nums = currentMetric === 'both' ?
    qCols('np').concat(qCols('rev')) : qCols(currentMetric);
  const yoys = currentMetric === 'both' ?
    yoyCols('np').concat(yoyCols('rev')) : yoyCols(currentMetric);
  if(nums.length === 0){ svg.innerHTML = `<text x="400" y="120" text-anchor="middle" fill="#888" font-size="12">暂无数据</text>`; return; }
  let valMin = Math.min(...nums), valMax = Math.max(...nums);
  if(valMin > 0) valMin = 0;
  if(valMax === valMin) valMax = valMin + 1;
  let yoyMin = yoys.length ? Math.min(...yoys) : -0.5, yoyMax = yoys.length ? Math.max(...yoys) : 0.5;
  if(yoyMin === yoyMax) yoyMax = yoyMin + 0.1;
  const valRange = valMax - valMin;
  const yoyRange = yoyMax - yoyMin;
  const groupW = chartW / data.length;
  const barW = (groupW / 5) * 0.85;
  // Y axis labels (left = value, right = yoy)
  for(let i=0; i<=4; i++){
    const y = PAD.t + chartH - chartH * i / 4;
    const val = valMin + valRange * i / 4;
    const yoyVal = yoyMin + yoyRange * i / 4;
    svg.insertAdjacentHTML('beforeend', `<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${y}" y2="${y}" stroke="#eef0f3"/>`);
    svg.insertAdjacentHTML('beforeend', `<text x="${PAD.l-6}" y="${y+3}" text-anchor="end" fill="#999" font-size="10">${formatYi(val)}</text>`);
    svg.insertAdjacentHTML('beforeend', `<text x="${W-PAD.r+6}" y="${y+3}" text-anchor="start" fill="#999" font-size="10">${(yoyVal*100).toFixed(0)}%</text>`);
  }
  // x 轴标签
  data.forEach((d, idx) => {
    const cx = PAD.l + groupW * (idx + 0.5);
    const labelMain = `${d.year}年`;
    const labelSub = (d === cur) ? '一季报' : '';
    const yBase = H - 12;
    svg.insertAdjacentHTML('beforeend', `<text x="${cx}" y="${yBase}" text-anchor="middle" fill="#666" font-size="11">${labelMain}${labelSub ? '<tspan fill="#3b6ff0" font-weight="600"> · '+labelSub+'</tspan>' : ''}</text>`);
  });
  // bars：以 0 为基准线，正向上、负向下
  const qColors = ['#3b6ff0', '#5b8cf7', '#7fa7f4', '#a3c1ee'];
  const zeroY = PAD.t + chartH - ((0 - valMin) / valRange) * chartH;
  data.forEach((d, idx) => {
    const gx = PAD.l + groupW * idx + (groupW - 4 * barW) / 2;
    ['Q1','Q2','Q3','Q4'].forEach((q, qi) => {
      const m = currentMetric === 'both' ? (qi < 2 ? 'np' : 'rev') : currentMetric;
      const v = d[m]?.[q];
      if(v == null) return;
      const yV = PAD.t + chartH - ((v - valMin) / valRange) * chartH;
      const rectTop = Math.min(zeroY, yV);
      const rectH = Math.abs(zeroY - yV);
      const x = gx + qi * (groupW / 4);
      const color = currentMetric === 'both' ? (m === 'np' ? qColors[qi] : '#ff7a00') : qColors[qi];
      svg.insertAdjacentHTML('beforeend', `<rect x="${x}" y="${rectTop}" width="${barW}" height="${rectH}" fill="${color}" rx="2"/>`);
    });
  });
  // 0 基准线
  svg.insertAdjacentHTML('beforeend', `<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${zeroY}" y2="${zeroY}" stroke="#bbb" stroke-width="1" stroke-dasharray="4,2"/>`);
  // yoy line per metric
  const drawYoy = (key, color) => {
    const points = [];
    data.forEach((d, idx) => {
      const gx = PAD.l + groupW * (idx + 0.5);
      ['Q1','Q2','Q3','Q4'].forEach((q, qi) => {
        const yoy = d[key + 'YoY']?.[q];
        if(yoy == null) return;
        const y = PAD.t + chartH - ((yoy - yoyMin) / yoyRange) * chartH;
        points.push({ x: gx + (groupW / 4) * (qi - 1.5), y });
      });
    });
    if(points.length > 1){
      const path = points.map((p,i) => (i===0?'M':'L') + p.x + ',' + p.y).join(' ');
      svg.insertAdjacentHTML('beforeend', `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="3,2"/>`);
      points.forEach(p => svg.insertAdjacentHTML('beforeend', `<circle cx="${p.x}" cy="${p.y}" r="2" fill="${color}"/>`));
    }
  };
  if(currentMetric === 'np' || currentMetric === 'both') drawYoy('np', '#ff7a00');
  if(currentMetric === 'rev' || currentMetric === 'both') drawYoy('rev', '#3b6ff0');
}

function formatYi(v){
  const abs = Math.abs(v);
  if(abs >= 1e9) return (v/1e9).toFixed(0) + '亿';
  if(abs >= 1e8) return (v/1e8).toFixed(1) + '亿';
  if(abs >= 1e4) return (v/1e4).toFixed(0) + '万';
  return v.toFixed(0);
}

// ----- 股东回报规划 -----
function renderPlan(data){
  const root = document.getElementById('plan-list');
  root.innerHTML = '';
  const plan = data.shareholderPlan || { found: false, items: [], dividendFloor: null, dividendFloorText: null };
  if(!plan.found){
    root.innerHTML = '<div class="empty-tip">未检索到股东回报规划 / 分红方案（最近公告窗口内）</div>';
    return;
  }
  // 分红比例下限状态条
  let badge;
  if(plan.dividendFloor != null){
    badge = `<div class="floor-badge ok">✅ 有明确分红比例下限：现金分红 ≥ ${plan.dividendFloor}%</div>`;
  } else {
    badge = `<div class="floor-badge warn">⚠️ 有回报规划 / 分红方案，但正文中未提取到明确的分红比例下限（如仅“提质增效重回报”未列具体比例，详见下方原文链接）</div>`;
  }
  root.insertAdjacentHTML('beforeend', badge);
  if(plan.dividendFloorText){
    root.insertAdjacentHTML('beforeend', `<div class="floor-text">原文：${plan.dividendFloorText}</div>`);
  }
  plan.items.forEach(it => {
    const link = it.pdf || it.url;
    const div = document.createElement('div');
    div.className = 'plan-item';
    div.innerHTML = `<span class="plan-date">${it.date}</span>${
      link ? `<a href="${link}" target="_blank">${it.title}</a>` : it.title
    }`;
    root.appendChild(div);
  });
}

// ----- 投资者交流记录 -----
function renderIR(data){
  const root = document.getElementById('ir-list');
  root.innerHTML = '';
  const irs = data.irRecords || [];
  if(!irs.length){
    root.innerHTML = '<div class="empty-tip">无投资者交流记录</div>';
    return;
  }
  irs.forEach(it => {
    const link = it.pdf || it.url;
    const div = document.createElement('div');
    div.className = 'ir-item';
    div.innerHTML = `<span class="ir-tag">IR</span><span class="plan-date">${it.date}</span>${
      link ? `<a href="${link}" target="_blank">${it.title}</a>` : it.title
    }`;
    root.appendChild(div);
  });
}

// ----- 近4年法律/监管/道德风险（污点）-----
function renderBlemish(data){
  const root = document.getElementById('blemish-list');
  const badge = document.getElementById('blemish-badge');
  const list = (data && data.blemish) || [];
  if(!list.length){
    if(badge){ badge.className = 'meta ok'; badge.textContent = '✅ 无近期污点'; }
    if(root) root.innerHTML = '<div class="empty-tip">近 ~1 年公告中未发现行政处罚 / 立案调查 / 公开谴责 / 财务造假 / 环保处罚 / 失信等负面记录。<br>（公告接口单只仅返回最近约 100 条，无法保证覆盖完整 4 年；如需严格近 4 年请手动维护名单）</div>';
    return;
  }
  if(badge){ badge.className = 'meta bad'; badge.textContent = '⚠️ ' + list.length + ' 项'; }
  if(root){
    root.innerHTML = '';
    list.forEach(it => {
      const link = it.url;
      const div = document.createElement('div');
      div.className = 'blemish-item';
      div.innerHTML = `<span class="blemish-tag">风险</span><span class="plan-date">${it.date}</span>${
        link ? `<a href="${link}" target="_blank">${it.title}</a>` : it.title
      }`;
      root.appendChild(div);
    });
  }
}

// ----- url ?code= 自动选中 -----
// ----- 数据健康度条 -----
async function loadHealth(){
  try{
    const r = await fetch(dataUrl('health.json'), { cache:'no-cache' });
    if(!r.ok) return;
    const h = await r.json();
    const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
    set('h-total', h.total);
    set('h-complete', h.completePct);
    const prog=document.getElementById('h-progress'); if(prog) prog.style.width=(h.completePct||0)+'%';
    set('h-hard', h.hardMissing);
    set('h-kline', h.klineBad);
    set('h-plan', h.noPlan);
    const hardWrap=document.getElementById('h-hard-wrap');
    if(hardWrap){ hardWrap.classList.toggle('bad', h.hardMissing>200); hardWrap.classList.toggle('warn', h.hardMissing>0&&h.hardMissing<=200); }
    const det=document.getElementById('health-detail');
    if(det){
      const labels={histPE:'PE历史百分位',histPB:'PB历史百分位',avgRoce:'ROCE(资本回报率)',avgPayout:'派息比例',annualDps:'年度每股分红',netCashRatio:'净现金率'};
      let html='<h4>缺失因子分布（评分因子无法计算 = 该因子不计分）</h4>';
      const mt=h.missingTypes||{};
      if(Object.keys(mt).length===0) html+='<div class="issue">✓ 暂无缺失因子</div>';
      else for(const [k,v] of Object.entries(mt).sort((a,b)=>b[1]-a[1])) html+=`<div class="miss-row"><span>${labels[k]||k}</span><span>${v} 只</span></div>`;
      html+='<h4 style="margin-top:10px">评分缺项样例</h4><div class="issues">';
      for(const it of (h.topIssues||[])) html+=`<div class="issue">${it.code} ${it.name}：${it.issues.join('；')}</div>`;
      html+='</div>';
      det.innerHTML=html;
    }
    const tog=document.getElementById('h-toggle');
    if(tog) tog.onclick=()=>{ const d=document.getElementById('health-detail'); d.classList.toggle('show'); tog.textContent=d.classList.contains('show')?'明细 ▴':'明细 ▾'; };
  }catch(e){ /* 静默：健康度条为辅助信息 */ }
}

async function maybeAutoSelect(){
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if(code){
    await selectCode(code.toLowerCase());
  }
}

// ----- 星标 + 标记框（拟买入）-----
function updateStar(){
  const sb = document.getElementById('star-btn');
  const hint = document.getElementById('star-hint');
  if(!sb) return;
  const inWatch = !!(currentCode && WS.isWatched(currentCode));
  const inHold  = !!(currentCode && WS.getHold().some(x => x.code === currentCode));
  const starred = inWatch || inHold;
  if(starred){
    sb.textContent = '★'; sb.classList.add('on');
    const where = (inWatch ? '标记框' : '') + (inWatch && inHold ? ' · ' : '') + (inHold ? '持股框' : '');
    if(inWatch){
      sb.title = '已在标记框' + (inHold ? ' · 持股框' : '') + ' · 点击从标记框移出';
    } else {
      sb.title = '在持股框 · 点击加入标记框';
    }
    if(hint){ hint.textContent = '在 ' + where; hint.classList.add('on'); }
  } else {
    sb.textContent = '☆'; sb.classList.remove('on'); sb.title = '加入标记框';
    if(hint){ hint.textContent = ''; hint.classList.remove('on'); }
  }
}
let watchPrices = {};   // code -> 现价（标记框实时价缓存）
window.__renderWatch = renderWatch;   // 供持股框页面"已卖出"后回写标记框

// 标记框排序：① 特殊关注（★）永远最前；② 正在浏览的公司；③ 已达目标买入价（提醒状态）；④ 其余按原顺序
function watchRank(it){
  if(it.star) return 0;                                           // 特殊关注 → 最前
  if(currentCode && it.code === currentCode) return 1;           // 正在浏览
  const price = watchPrices[it.code];
  if(it.targetBuy != null && price != null && price <= it.targetBuy) return 2; // 提醒状态
  return 3;                                                       // 其余
}
function sortWatchList(list){
  return list.map((it, i) => ({ it: it, i: i, r: watchRank(it) }))
             .sort((a, b) => a.r - b.r || a.i - b.i)
             .map(x => x.it);
}

function renderWatch(){
  const root = document.getElementById('watch-list');
  if(!root) return;
  const list = sortWatchList(WS.getWatch());
  // 重建前：若用户正聚焦于标记框内某输入控件，记录焦点 + 光标，重建后恢复，
  // 避免任何重建（加星/买入/导入/云端恢复）打断正在输入的备注或目标买入价
  let _focus = null;
  const _ae = document.activeElement;
  if(_ae && root.contains(_ae) && _ae.dataset && _ae.dataset.code){
    const cls = _ae.className || '';
    _focus = { code: _ae.dataset.code, isNote: cls.indexOf('wc-note') >= 0, isTb: cls.indexOf('tb-input') >= 0,
               start: _ae.selectionStart, end: _ae.selectionEnd };
  }
  const cntEl = document.getElementById('watch-count');
  if(cntEl) cntEl.textContent = list.length;
  if(!list.length){
    root.innerHTML = '<div class="empty-tip">暂无标记。在上方评分框点击 ☆ 即可把公司加入此标记框；填入「目标买入价」后，当现股价 ≤ 目标时会自动提醒买入。</div>';
    return;
  }
  let html = '<div class="watch-grid">';
  for(const it of list){
    const price = watchPrices[it.code];
    const reach = (it.targetBuy != null && price != null && price <= it.targetBuy);
    html += `<div class="watch-card" data-code="${it.code}">
      <div class="wc-top">
        <button class="wc-star ${it.star?'on':''}" data-act="star" data-code="${it.code}" title="特殊关注：点一下切换，★ 会排到标记框最前">${it.star?'★':'☆'}</button>
        <div class="wc-name">
          <strong>${it.name}</strong>
          <span class="code-sm">${it.code.toUpperCase()}</span>
          <span class="wc-alert" id="wa-${it.code}">${reach?'已达买入目标 ✓':''}</span>
        </div>
        <div class="wc-price" id="wp-${it.code}">${price!=null?'¥'+price.toFixed(2):'—'}</div>
      </div>
      <div class="wc-actions">
        <input type="number" step="0.01" min="0" placeholder="目标买入" value="${it.targetBuy!=null?it.targetBuy:''}" data-code="${it.code}" class="tb-input">
        <button class="mini-btn primary" data-act="buy" data-code="${it.code}">买入</button>
      </div>
      <textarea class="wc-note" data-code="${it.code}" placeholder="备注…" maxlength="500"></textarea>
    </div>`;
  }
  html += '</div>';
  root.innerHTML = html;
  root.querySelectorAll('.tb-input').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const code = inp.dataset.code;
      const v = parseFloat(inp.value);
      const a = WS.getWatch(); const it = a.find(x=>x.code===code);
      if(it){ it.targetBuy = (v>0 ? v : null); WS.setWatch(a); refreshWatchPrices(); }
    });
  });
  root.querySelectorAll('.wc-note').forEach(ta=>{
    const it = list.find(x=>x.code===ta.dataset.code);
    ta.value = (it && it.note) || '';
    const save = ()=>{
      const code = ta.dataset.code;
      const a = WS.getWatch(); const it2 = a.find(x=>x.code===code);
      if(it2){ it2.note = ta.value; WS.setWatch(a); }
    };
    // 输入即存（input），不必等失焦 —— 即便重建也保留最新文字
    ta.addEventListener('input', save);
    ta.addEventListener('change', save);
  });
  root.querySelectorAll('button[data-act="buy"]').forEach(b=>{
    b.onclick = ()=>{
      const code = b.dataset.code;
      const it = list.find(x=>x.code===code);
      const def = watchPrices[code] || (it && it.targetBuy) || '';
      openBuyModal(code, (it && it.name) || code, def);
    };
  });
  root.querySelectorAll('.wc-star').forEach(s=>{
    s.addEventListener('click', ()=>{
      const code = s.dataset.code;
      const a = WS.getWatch(); const it2 = a.find(x=>x.code===code);
      if(it2){ it2.star = !it2.star; WS.setWatch(a); renderWatch(); }
    });
  });
  // 恢复焦点 + 光标（若重建前正在输入）
  if(_focus){
    const sel = _focus.isNote
      ? Array.from(root.querySelectorAll('.wc-note')).find(e=>e.dataset.code===_focus.code)
      : Array.from(root.querySelectorAll('.tb-input')).find(e=>e.dataset.code===_focus.code);
    if(sel){ sel.focus(); try{ sel.setSelectionRange(_focus.start, _focus.end); }catch(e){} }
  }
}

// 实时价刷新后，仅移动现有 DOM 节点而不重建（保留输入框焦点），让提醒中的公司自动前移
function reorderWatchDom(){
  const grid = document.querySelector('#watch-list .watch-grid');
  if(!grid) return;
  // 用户正聚焦于标记框内的输入控件（备注 / 目标买入价）时不重排，
  // 避免每 15s 的价格刷新移动 DOM 节点、打断中文输入法组合（"写着就断掉"），也保住光标
  const ae = document.activeElement;
  if(ae && grid.contains(ae) && ae.dataset && ae.dataset.code && /wc-note|tb-input/.test(ae.className || '')) return;
  const order = WS.getWatch();
  const idx = {};
  order.forEach((it, i) => { idx[it.code] = i; });
  const cards = Array.prototype.slice.call(grid.querySelectorAll('.watch-card'));
  if(!cards.length) return;
  const rankOf = function(c){
    const code = c.dataset.code;
    const it = order.find(function(x){ return x.code === code; });
    if(it && it.star) return 0;                                  // 特殊关注 → 最前
    if(currentCode && code === currentCode) return 1;
    const price = watchPrices[code];
    if(it && it.targetBuy != null && price != null && price <= it.targetBuy) return 2;
    return 3;
  };
  cards.sort(function(a, b){ return rankOf(a) - rankOf(b) || (idx[a.dataset.code] || 0) - (idx[b.dataset.code] || 0); });
  cards.forEach(function(c){ grid.appendChild(c); }); // appendChild 移动节点，保持排序
}

// 买入弹框：让用户输入「实际买入价格」（可能与目标买入价不同）
function openBuyModal(code, name, def){
  const mask = document.getElementById('buy-modal');
  const inp = document.getElementById('buy-price-input');
  const title = document.getElementById('buy-modal-title');
  if(!mask || !inp) return;
  title.textContent = '买入 ' + name;
  inp.value = (def > 0 ? def : '');
  mask.style.display = 'flex';
  setTimeout(()=>inp.focus(), 30);
  const cleanup = ()=>{
    document.getElementById('buy-confirm').onclick = null;
    document.getElementById('buy-cancel').onclick = null;
    mask.onclick = null;
    inp.onkeydown = null;
  };
  const cancel = ()=>{ mask.style.display = 'none'; cleanup(); };
  const confirm = ()=>{
    const v = parseFloat(inp.value);
    if(!(v > 0)){ alert('请输入有效的买入价格'); return; }
    mask.style.display = 'none';
    WS.buy(code, v);
    renderWatch();
    if(window.__renderHold) window.__renderHold();
    cleanup();
  };
  document.getElementById('buy-confirm').onclick = confirm;
  document.getElementById('buy-cancel').onclick = cancel;
  mask.onclick = (e)=>{ if(e.target === mask) cancel(); };
  inp.onkeydown = (e)=>{ if(e.key === 'Enter') confirm(); if(e.key === 'Escape') cancel(); };
}

async function refreshWatchPrices(){
  const list = WS.getWatch();
  if(!list.length) return;
  const codes = list.map(x=>x.code);
  const q = await WS.fetchQuotes(codes);
  let changed = false;
  for(const code of codes){
    if(q[code] != null){
      watchPrices[code] = q[code].price;
      const el = document.getElementById('wp-'+code);
      if(el) el.textContent = '¥'+q[code].price.toFixed(2);
      const it = list.find(x=>x.code===code);
      const ae = document.getElementById('wa-'+code);
      if(ae && it){
        const reach = (it.targetBuy != null && q[code].price <= it.targetBuy);
        ae.innerHTML = reach ? '<span class="alert-buy">已达买入目标 ✓ 提醒买入</span>' : '';
      }
      changed = true;
    }
  }
  reorderWatchDom(); // 价格更新后按提醒状态重新排序（仅移动节点，不重建）
  return changed;
}

// ----- ROCE > 20% 公司汇总（剔除状态本地持久化）-----
const ROCE_EXCLUDE_KEY = 'szcq_roce_exclude_v1';
let roce20 = [];                 // 全量（ROCE>20，未剔除）
let roceExclude = new Set();     // 已剔除的 code（小写）
let roceSyn = {};                // grpKey -> { name, syn } 行业框架（主要指标+主要矛盾+前瞻定性）
let roceSortFps = false;         // ROCE 弹窗排序：false=按ROCE，true=按前瞻优先级(FPS)
function tierClass(t){ if(t && t.indexOf('P1')===0) return 'tier-p1'; if(t && t.indexOf('P2')===0) return 'tier-p2'; if(t && t.indexOf('P3')===0) return 'tier-p3'; return 'tier-p4'; }
function moatClass(m){ return m==='强'?'moat-strong':m==='中'?'moat-mid':m==='弱'?'moat-weak':m==='薄'?'moat-thin':m==='衰减'?'moat-decay':'moat-none'; }
function fwdClass(v){ if(v==null) return 'fwd-0'; if(v>=4) return 'fwd-pos2'; if(v>=1) return 'fwd-pos1'; if(v<=-4) return 'fwd-neg2'; if(v<=-1) return 'fwd-neg1'; return 'fwd-0'; }
// 前瞻赋分 = 行业需求趋势(D) + 行业政策/供给对冲(P) + 公司竞争位势(C) + 公司成长动能(O)
function fwdTip(d){
  const sg = v => (v>0?'+':'')+v;
  const parts = [];
  if(d.fwdD!=null) parts.push('D 行业需求趋势 '+sg(d.fwdD));
  if(d.fwdP!=null) parts.push('P 政策/供给对冲 '+sg(d.fwdP));
  if(d.fwdC!=null) parts.push('C 公司竞争位势 '+sg(d.fwdC));
  if(d.fwdO!=null) parts.push('O 公司成长动能 '+sg(d.fwdO));
  let t = '前瞻赋分 fwdSc = D + P + C + O（各子项相加，|合计|>8 时软收口至 ±10）。';
  t += '\\n【行业组】'+(d.fwdGrp||'-');
  if(parts.length) t += ' ｜ '+parts.join(' ｜ ');
  const srcName = d.fwdSrc==='manual' ? '逐家人工分析' : (d.fwdSrc==='auto' ? '量化代理（行业内超额营收增速/定价权/规模/稳定性 + 最新单季动能）' : '数据不足');
  t += '\\n【公司差异来源】'+srcName;
  if(d.fwdNote) t += '\\n【依据】'+d.fwdNote;
  return t.replace(/"/g,'&quot;');
}

function loadRoceExclude(){
  try {
    const a = JSON.parse(localStorage.getItem(ROCE_EXCLUDE_KEY) || '[]');
    if(Array.isArray(a)) roceExclude = new Set(a.map(c => String(c).toLowerCase()));
  } catch(e){ /* ignore */ }
}
function saveRoceExclude(){
  try { localStorage.setItem(ROCE_EXCLUDE_KEY, JSON.stringify(Array.from(roceExclude))); } catch(e){ /* 容量超限忽略 */ }
}
function excludeRoce(code){ roceExclude.add(String(code).toLowerCase()); saveRoceExclude(); }
function restoreRoceAll(){ roceExclude = new Set(); saveRoceExclude(); }
function roceVisible(){ return roce20.filter(e => !roceExclude.has(String(e.code).toLowerCase())); }

async function loadRoce(){
  try {
    const arr = await fetch(dataUrl('roce20.json'), { cache:'no-cache' }).then(r=>{
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    });
    roce20 = Array.isArray(arr) ? arr : [];
  } catch(e){
    console.warn('roce20 加载失败：', e.message);
  }
  // 行业框架（主要指标+主要矛盾+前瞻定性），供每家「前瞻」展开
  try {
    roceSyn = await fetch(dataUrl('roce20_syn.json'), { cache:'no-cache' }).then(r=> r.ok ? r.json() : {});
  } catch(e){ roceSyn = {}; }
  updateRoceCount();
}
function updateRoceCount(){
  const el = document.getElementById('roce-count');
  if(el) el.textContent = roceVisible().length;
}
function openRoceModal(){
  const m = document.getElementById('roce-modal');
  const list = document.getElementById('roce-list');
  if(!m || !list) return;
  let vis = roceVisible();
  vis = vis.slice().sort(roceSortFps
    ? (a,b)=> (b.fps-a.fps) || (b.roce-a.roce)
    : (a,b)=> (b.roce-a.roce) || (b.total-a.total));
  const cnt = document.getElementById('roce-modal-count');
  if(cnt) cnt.textContent = vis.length;
  const sortBtn = document.getElementById('roce-sort');
  if(sortBtn) sortBtn.textContent = roceSortFps ? '按 前瞻优先级 ▾' : '按 ROCE ▾';
  if(!vis.length){
    list.innerHTML = '<div class="roce-empty">暂无可显示的公司（已全部剔除）</div>';
  } else {
    list.innerHTML = vis.map(e => `
      <div class="roce-row" data-code="${e.code}">
        <div class="ro-main">
          <div class="ro-name"><strong>${e.name}</strong><span class="ro-code">${e.code.toUpperCase()}</span>${e.grp?`<span class="ro-grp">${e.grp}</span>`:''}${e.tier?`<span class="ro-tier ${tierClass(e.tier)}">${e.tier}</span>`:''}${e.moatTag?`<span class="ro-moat ${moatClass(e.moatTag)}" title="${(e.moatNote||'').replace(/"/g,'&quot;')}">🛡${e.moatTag}</span>`:''}</div>
          <div class="ro-stats">ROCE ${e.roce!=null?e.roce.toFixed(1):'–'}% · 评分 ${e.total}${e.soe?` · ${e.soe}`:''}</div>
        </div>
        <button class="ro-toggle" data-code="${e.code}">前瞻▸</button>
        <div class="ro-fps" title="前瞻优先级分 FPS（0~100）">${e.fps!=null?e.fps:'–'}</div>
        <div class="ro-sc" title="结构分（8因子）">${e.total}</div>
        <button class="ro-exclude" data-code="${e.code}">剔除</button>
        <div class="ro-fw" data-code="${e.code}" style="display:none"></div>
      </div>
    `).join('');
    list.querySelectorAll('.roce-row').forEach(row=>{
      const code = row.dataset.code;
      row.onclick = (ev)=>{
        if(ev.target.classList.contains('ro-exclude')) return;   // 点「剔除」不触发详情
        if(ev.target.classList.contains('ro-toggle')) return;    // 点「前瞻」不触发详情/不收起弹窗
        if(ev.target.closest('.ro-fw')) return;                  // 在展开的分析区内点击不收起弹窗
        selectCode(code);
        closeRoceModal();
      };
    });
    list.querySelectorAll('.ro-toggle').forEach(btn=>{
      btn.onclick = (ev)=>{
        ev.stopPropagation();
        const code = btn.dataset.code;
        const row = btn.closest('.roce-row');
        const fw = row.querySelector('.ro-fw');
        const open = fw.style.display !== 'none';
        if(open){ fw.style.display = 'none'; btn.textContent = '前瞻▸'; }
        else {
          if(!fw.dataset.filled){
            const e = roce20.find(x=>x.code===code);
            const syn = e && e.grpKey ? (roceSyn[e.grpKey]||{}).syn : null;
            let html = '';
            if(e && e.moatNote) html += `<div class="ro-fw-moat">🛡️ 护城河（${e.moatTag||'—'}）：${e.moatNote}</div>`;
            if(e && e.reason) html += `<div class="ro-fw-reason">📌 ${e.reason}</div>`;
            if(syn) html += `<div class="ro-fw-syn">${syn}</div>`;
            if(e && e.fw) html += `<div class="ro-fw-item">${e.fw}</div>`;
            fw.innerHTML = html;
            fw.dataset.filled = '1';
          }
          fw.style.display = 'block'; btn.textContent = '前瞻▾';
        }
      };
    });
    list.querySelectorAll('.ro-exclude').forEach(btn=>{
      btn.onclick = (ev)=>{
        ev.stopPropagation();
        excludeRoce(btn.dataset.code);
        openRoceModal();   // 重渲染：该行消失
      };
    });
  }
  m.style.display = 'flex';
}
function closeRoceModal(){ const m = document.getElementById('roce-modal'); if(m) m.style.display = 'none'; }
function attachRoce(){
  const entry = document.getElementById('roce-entry');
  if(entry) entry.onclick = openRoceModal;
  const close = document.getElementById('roce-close');
  if(close) close.onclick = closeRoceModal;
  const sortBtn = document.getElementById('roce-sort');
  if(sortBtn) sortBtn.onclick = () => { roceSortFps = !roceSortFps; openRoceModal(); };
  const restore = document.getElementById('roce-restore');
  if(restore) restore.onclick = () => { if(confirm('恢复全部已剔除的 ROCE 公司？')){ restoreRoceAll(); openRoceModal(); } };
  const mask = document.getElementById('roce-modal');
  if(mask) mask.onclick = (e)=>{ if(e.target === mask) closeRoceModal(); };
}

// ----- init -----
(async () => {
  attachSearch();   // 立即绑定，搜索框可交互（不等待数据加载）
  attachRankSearch(); // 绑定排名搜索框
  attachBoardJump();  // 绑定榜单标题处的「跳至排名」输入框
  const boardRoot = document.getElementById('board-top10');
  if(boardRoot) boardRoot.addEventListener('scroll', onBoardScroll);
  // 星标按钮
  const sb = document.getElementById('star-btn');
  if(sb) sb.onclick = () => {
    if(!currentCode || !currentData){ return; }
    WS.toggleWatch(currentCode, currentData.name);
    updateStar();
    renderWatch();
  };
  loadBoard();      // 不阻塞：排行榜自行加载渲染
  loadIndex();      // 不阻塞：localStorage 缓存优先 + 后台更新
  loadHealth();    // 不阻塞：数据健康度条
  loadRoceExclude(); // 读取本地已剔除列表
  loadRoce();      // 不阻塞：ROCE>20% 公司汇总
  attachRoce();    // 绑定 ROCE 入口与弹窗
  renderWatch();   // 立即渲染标记框（含空态）
  refreshWatchPrices(); // 拉一次现股价
  await maybeAutoSelect();
  // 每 30s 自动重拉实时价
  setInterval(() => { if(currentCode) refreshPrice(); }, 30000);
  // 每 15s 刷新标记框现股价 + 买入提醒
  setInterval(refreshWatchPrices, 15000);
})().catch(e => console.error(e));

// ----- 标记框 导出/导入（换网址/清缓存时恢复本地数据） -----
(function(){
  function download(filename, text){
    var blob = new Blob([text], {type:'application/json'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  var expBtn = document.getElementById('watch-export');
  var impBtn = document.getElementById('watch-import');
  var impFile = document.getElementById('watch-import-file');
  if(expBtn) expBtn.onclick = function(){
    var data = { type:'watch', version:1, exportedAt: new Date().toISOString(), data: WS.getWatch() };
    download('watch_backup.json', JSON.stringify(data, null, 2));
  };
  if(impBtn && impFile) impBtn.onclick = function(){ impFile.click(); };
  if(impFile) impFile.onchange = function(){
    var f = impFile.files && impFile.files[0]; if(!f) return;
    var rd = new FileReader();
    rd.onload = function(){
      try{
        var obj = JSON.parse(rd.result);
        var arr = Array.isArray(obj) ? obj : (obj.data || obj.watch);
        if(!Array.isArray(arr)) throw new Error('文件格式不对（缺少 data 数组）');
        if(!confirm('将用导入的 ' + arr.length + ' 条覆盖当前标记框，确定？')){ impFile.value=''; return; }
        WS.setWatch(arr);
        renderWatch();
        if(typeof refreshWatchPrices === 'function') refreshWatchPrices();
        alert('标记框已导入 ' + arr.length + ' 条');
      }catch(err){ alert('导入失败：' + err.message); }
      impFile.value = '';
    };
    rd.readAsText(f);
  };
})();

// ----- 标记框 云端备份/恢复（Netlify Function + Blobs，点一下即存，无需发助手） -----
(function(){
  var CLOUD_API = '/.netlify/functions/backup';
  var backupBtn = document.getElementById('watch-cloud-backup');
  if(backupBtn) backupBtn.onclick = function(){
    var data = { watch: WS.getWatch(), hold: WS.getHold(), capital: WS.getCapital() };
    var old = backupBtn.textContent;
    backupBtn.disabled = true; backupBtn.textContent = '备份中…';
    fetch(CLOUD_API, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) })
      .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
      .then(function(res){
        if(res.ok && res.d && res.d.ok) alert('已备份到云端（标记/持股/资金已保存，时间 ' + (res.d.updatedAt || '') + '）');
        else alert('备份失败：' + ((res.d && res.d.error) || '未知错误'));
      })
      .catch(function(e){ alert('备份失败：' + e.message); })
      .finally(function(){ backupBtn.disabled = false; backupBtn.textContent = old; });
  };
  var restoreBtn = document.getElementById('watch-cloud-restore');
  if(restoreBtn) restoreBtn.onclick = function(){
    fetch(CLOUD_API, { cache:'no-cache' }).then(function(r){ if(!r.ok) throw new Error('云端暂无备份'); return r.json(); })
      .then(function(obj){
        var arr = Array.isArray(obj) ? obj : (obj.watch || obj.data || []);
        if(!Array.isArray(arr)) throw new Error('云端备份格式不对');
        if(!confirm('将用云端备份覆盖当前标记框（' + arr.length + ' 条），确定？')) return;
        WS.setWatch(arr); renderWatch();
        if(typeof refreshWatchPrices === 'function') refreshWatchPrices();
        alert('已从云端恢复标记框 ' + arr.length + ' 条');
      }).catch(function(e){ alert('云端恢复失败：' + e.message); });
  };
})();

// ----- 深度分析（定性 + 定量）-----
// 数据文件 deep_analysis.json：{ code: { name, date, verdict, tags[], quant[][], sections[{t,items[]}] } }
// 在评分卡标题（公司名 + ☆ 旁）显示「深度分析」按钮，点开弹出该公司的定性与定量结论。
var DEEP_DB = null, DEEP_TRIED = false;
async function loadDeepDB(){
  if(DEEP_TRIED) return DEEP_DB;
  DEEP_TRIED = true;
  try{
    const r = await fetch(dataUrl('deep_analysis.json'), { cache:'no-cache' });
    DEEP_DB = r.ok ? await r.json() : {};
  }catch(e){ DEEP_DB = {}; console.warn('deep_analysis.json 加载失败:', e.message); }
  return DEEP_DB;
}
function deepHas(code){ return !!(DEEP_DB && DEEP_DB[code]); }
function deepEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function openDeep(code){
  const a = DEEP_DB && DEEP_DB[code];
  if(!a){ return; }
  document.getElementById('deep-title').innerHTML = deepEsc(a.name || code) + ' · 深度分析';
  const tags = (a.tags && a.tags.length) ? a.tags.map(t=>'<span class="deep-tag">'+deepEsc(t)+'</span>').join(' ') : '';
  document.getElementById('deep-sub').innerHTML =
    (a.date ? '分析日期 ' + deepEsc(a.date) + ' ｜ ' : '') + '定性判断 + 定量关键指标' + (tags ? ' ｜ ' + tags : '');
  let h = '';
  if(a.verdict) h += '<div class="deep-verdict"><b>结论：</b>' + deepEsc(a.verdict) + '</div>';
  if(a.quant && a.quant.length){
    h += '<div class="deep-quant">' + a.quant.map(q => '<div class="deep-q"><span>'+deepEsc(q[0])+'</span><b>'+deepEsc(q[1])+'</b></div>').join('') + '</div>';
  }
  (a.sections || []).forEach(s => {
    h += '<div class="deep-sec"><h4>' + deepEsc(s.t) + '</h4><ul>'
      + (s.items || []).map(i => '<li>' + deepEsc(i) + '</li>').join('') + '</ul></div>';
  });
  h += '<div style="font-size:11px;color:var(--muted);margin-top:6px">本分析基于公开数据与公司公告整理，不构成投资建议。</div>';
  document.getElementById('deep-body').innerHTML = h;
  document.getElementById('deep-modal').style.display = 'flex';
}
function closeDeep(){ const m = document.getElementById('deep-modal'); if(m) m.style.display = 'none'; }
(function initDeep(){
  const b = document.getElementById('deep-btn');
  if(b) b.onclick = () => { if(currentCode) openDeep(currentCode); };
  const c = document.getElementById('deep-close');
  if(c) c.onclick = closeDeep;
  const m = document.getElementById('deep-modal');
  if(m) m.onclick = (e) => { if(e.target === m) closeDeep(); };
  if(b) loadDeepDB().then(() => { if(currentData){ try { renderScore(); } catch(e){} } });
})();

// ----- 前瞻股息率可信度说明（点击股息率旁的红色标记弹出）-----
var __divWarnCtx = null;
function openDivWarn(){
  const c = __divWarnCtx; if(!c) return;
  const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  document.getElementById('divwarn-title').textContent = '前瞻股息率可信度说明';
  document.getElementById('divwarn-sub').innerHTML = esc(c.name) + '（' + esc(c.code) + '）';
  const rows = [
    ['前瞻股息率', (c.fwdDiv!=null? c.fwdDiv.toFixed(2)+'%' : '—') + (c.trailDiv>0? '（TTM 股息率 '+c.trailDiv.toFixed(2)+'%）' : (c.trailDiv===0? '（TTM 未分红）':''))],
    ['预估全年归母净利', c.estNp!=null? c.estNp+' 亿元（按去年同期节奏外推）' : '—'],
    ['去年派息率', c.payout!=null? c.payout.toFixed(0)+'%' : '—'],
    ['扣非 / 归母（TTM）', c.dedRatio!=null? c.dedRatio.toFixed(2) : '—'],
  ];
  let h = '<div class="dw-kv">' + rows.map(r=>'<span>'+esc(r[0])+'</span><b>'+esc(r[1])+'</b>').join('') + '</div>';
  h += '<div class="dw-why">为什么给出这个提示</div>';
  h += (c.reasons||[]).map(r=>'<div class="dw-li">'+esc(r)+'</div>').join('');
  h += '<div class="dw-note">前瞻股息率 = 预估全年归母净利润 × 去年派息率 ÷ 当前市值，即"假设公司按去年的派息比例分配今年的预估利润"。'
     + '触发提示的条件（满足任一）：① 前瞻股息率 ≥10%（A 股常态不足 8%）；② 支撑股息的利润含大额非经常性损益（扣非/归母低于 0.6）且股息率 ≥6%；③ 前瞻股息率 ≥2.5 倍 TTM 股息率且 ≥8%。'
     + '本提示仅为数据可信度提醒，不构成投资建议。</div>';
  document.getElementById('divwarn-body').innerHTML = h;
  document.getElementById('divwarn-modal').style.display = 'flex';
}
function closeDivWarn(){ const m = document.getElementById('divwarn-modal'); if(m) m.style.display = 'none'; }
(function initDivWarn(){
  const c = document.getElementById('divwarn-close'); if(c) c.onclick = closeDivWarn;
  const m = document.getElementById('divwarn-modal'); if(m) m.onclick = (e) => { if(e.target === m) closeDivWarn(); };
})();
