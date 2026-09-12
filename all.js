// 全部公司榜单 - 分页 + 因子筛选/排序（纯静态，无后端）
const $ = id => document.getElementById(id);

// 评分规则与前端一致（仅用于颜色）
function getCss(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function scoreColor(score, max){
  if(score===0) return {bg:getCss('--gr'), t:getCss('--grt')};
  const r = score/max;
  if(r>=0.8) return {bg:getCss('--g1'), t:getCss('--g1t')};
  if(r>=0.5) return {bg:getCss('--g2'), t:'#4F6228'};
  if(r>=0.3) return {bg:getCss('--y'), t:'#9C5700'};
  return {bg:getCss('--o'), t:'#974706'};
}

const PAGE_SIZE = 30;
const FACTORS = [
  {key:'peSc',   name:'前瞻PE分位', max:10, valKey:'fwdPePct', valFmt:v=>v==null?'—':v.toFixed(1)+'%'},
  {key:'pbSc',   name:'前瞻PB分位', max:10, valKey:'fwdPbPct', valFmt:v=>v==null?'—':v.toFixed(1)+'%'},
  {key:'divSc',  name:'前瞻股息率', max:20, valKey:'divY',  valFmt:v=>v==null?'—':v.toFixed(2)+'%'},
  {key:'ncSc',   name:'净现金',   max:10, valKey:'nc',    valFmt:v=>v==null?'—':v.toFixed(1)+'%'},
  {key:'atSc',   name:'属性',     max:10, valKey:null},
  {key:'roSc',   name:'ROCE',     max:10, valKey:'roce',  valFmt:v=>v==null?'—':v.toFixed(1)+'%'},
  {key:'paSc',   name:'派息',     max:10, valKey:'pay',   valFmt:v=>v==null?'—':v.toFixed(1)+'%'},
  {key:'cfSc',   name:'盈利质量', max:10, valKey:'cfComposite', valFmt:v=>v==null?'—':(v*100).toFixed(0)+'%'},
  {key:'fwdSc',  name:'前瞻赋分', min:-10, max:10, valKey:'fwdGrp', valFmt:v=>v==null?'—':v},
];
// “现价比一年最低点”独立展示列（不参与因子阈值筛选，仅展示+可排序）
const LOWYEAR = {key:'lowYearPct', name:'现价比一年最低', max:60, valFmt:v=>v==null?'—':v.toFixed(1)+'%', subFmt:(e)=>{ if(e.lowYearPct==null) return ''; if(Math.abs(e.lowYearPct)<0.5) return '近一年最低'; return '最低¥'+e.lowYear+(e.lowYearDate?'/'+e.lowYearDate:''); }};

let ALL = [];               // 全量数据
let view = [];              // 筛选+排序后
let currentPage = 1;
const state = {
  sortField:'total',
  sortDir:'desc',
  thresholds:{ peSc:0, pbSc:0, divSc:0, ncSc:0, atSc:0, roSc:0, paSc:0, cfSc:0, fwdSc:-10 },
  soe:''
};

// ---------- 阈值滑块 ----------
function buildThresholds(){
  const box = $('thresholds'); box.innerHTML='';
  for(const f of FACTORS){
    const row=document.createElement('div');
    row.className='thr';
    row.style.marginBottom='7px';
    const lbl=document.createElement('div');
    lbl.style.cssText='font-size:11.5px;color:var(--ink);margin-bottom:2px;';
    lbl.textContent=f.name;
    const input=document.createElement('input');
    input.type='range'; input.min=String(f.min!=null?f.min:0); input.max=String(f.max); input.step='1'; input.value='0';
    input.dataset.key=f.key;
    const tv=document.createElement('span');
    tv.className='tv'; tv.textContent='0';
    input.addEventListener('input',()=>{ tv.textContent=input.value; });
    row.appendChild(lbl);
    const line=document.createElement('div');
    line.style.cssText='display:flex;align-items:center;gap:8px;';
    line.appendChild(input); line.appendChild(tv);
    box.appendChild(line);
  }
}

// ---------- 应用筛选 + 排序 ----------
function apply(){
  // 读取阈值
  for(const f of FACTORS){
    const el=document.querySelector(`#thresholds input[data-key="${f.key}"]`);
    state.thresholds[f.key]= parseInt(el.value||'0',10);
  }
  let arr = ALL.filter(e=>{
    if(state.soe && e.soe!==state.soe) return false;
    for(const f of FACTORS){
      const min=state.thresholds[f.key];
      if(min>0 && (e[f.key]==null || e[f.key]<min)) return false;
    }
    return true;
  });
  const dir = state.sortDir==='asc'?1:-1;
  const fld = state.sortField;
  arr.sort((a,b)=>{
    let av=a[fld], bv=b[fld];
    if(av==null) av=-1e9; if(bv==null) bv=-1e9;
    return (av-bv)*dir;
  });
  view = arr;
  currentPage = 1;
  render();
}

// ---------- 渲染表格 ----------
function render(){
  const total = view.length;
  const pages = Math.max(1, Math.ceil(total/PAGE_SIZE));
  if(currentPage>pages) currentPage=pages;
  const start=(currentPage-1)*PAGE_SIZE;
  const slice=view.slice(start, start+PAGE_SIZE);

  $('mcount').textContent=`共 ${total} 家（当前第 ${currentPage}/${pages} 页）`;

  const head=`<tr>
    <th data-sort="rank">排名<span class="arrow">⇅</span></th>
    <th style="text-align:left">公司</th>
    <th>总分</th>
    ${FACTORS.map(f=>`<th data-sort="${f.key}">${f.name}<span class="arrow">⇅</span></th>`).join('')}
    <th data-sort="lowYearPct">${LOWYEAR.name}<span class="arrow">⇅</span></th>
  </tr>`;

  const body = slice.map(e=>{
    const cells = FACTORS.map(f=>{
      const sc=e[f.key]==null?0:e[f.key];
      const col=scoreColor(sc,f.max);
      let sub='';
      if(f.valKey && e[f.valKey]!=null){ sub=`<span class="val-sub">${f.valFmt(e[f.valKey])}</span>`; }
      // 前瞻股息率可信度预警：命中时在数值旁加红色标记，悬停显示原因
      if(f.key==='divSc' && e.divFwdWarn){ sub += `<span class="warn-dot" title="点击查看前瞻股息率可信度说明" onclick="openDivWarnAll('${e.code}')">!</span>`; }
      return `<td><span class="sc" style="background:${col.bg};color:${col.t}">${e[f.key]==null?'—':e[f.key]}</span>${sub}</td>`;
    }).join('');
    const lySub = LOWYEAR.subFmt(e) ? `<span class="val-sub">${LOWYEAR.subFmt(e)}</span>` : '';
    const lyCell = `<td><span class="sc" style="background:${scoreColor(0,1).bg};color:var(--ink)">${e.lowYearPct==null?'—':LOWYEAR.valFmt(e.lowYearPct)}</span>${lySub}</td>`;
    return `<tr class="row" data-code="${e.code}">
      <td class="rank">${e.rank}</td>
      <td class="name">${e.name}<div class="code">${e.code}</div></td>
      <td class="total">${e.total}</td>
      ${cells}
      ${lyCell}
    </tr>`;
  }).join('');

  $('tableWrap').innerHTML=`<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  // 行点击 → 回主页并选中
  document.querySelectorAll('tr.row').forEach(tr=>{
    tr.onclick=()=>{ window.location.href='index.html?code='+tr.dataset.code; };
  });
  // 表头排序点击
  document.querySelectorAll('th[data-sort]').forEach(th=>{
    th.onclick=()=>{
      const f=th.dataset.sort;
      if(state.sortField===f){ state.sortDir = state.sortDir==='asc'?'desc':'asc'; }
      else { state.sortField=f; state.sortDir = (f==='rank')?'asc':'desc'; }
      // 同步 UI
      $('sortField').value = state.sortField;
      syncDirUI();
      apply();
    };
  });
  renderPager(pages);
}

function renderPager(pages){
  const p=$('pager'); p.innerHTML='';
  const mk=(label,page,opts={})=>{
    const b=document.createElement('button');
    b.textContent=label;
    if(opts.on) b.classList.add('on');
    if(opts.disabled) b.disabled=true;
    b.onclick=()=>{ if(!opts.disabled){ currentPage=page; render(); } };
    return b;
  };
  p.appendChild(mk('«',1,{disabled:currentPage===1}));
  p.appendChild(mk('‹',currentPage-1,{disabled:currentPage===1}));
  // 页码窗口
  let s=Math.max(1,currentPage-3), e=Math.min(pages,currentPage+3);
  if(s>1) p.appendChild(mk('1',1));
  if(s>2) { const d=document.createElement('span'); d.textContent='…'; d.className='info'; p.appendChild(d); }
  for(let i=s;i<=e;i++) p.appendChild(mk(String(i),i,{on:i===currentPage}));
  if(e<pages-1){ const d=document.createElement('span'); d.textContent='…'; d.className='info'; p.appendChild(d); }
  if(e<pages) p.appendChild(mk(String(pages),pages));
  p.appendChild(mk('›',currentPage+1,{disabled:currentPage===pages}));
  p.appendChild(mk('»',pages,{disabled:currentPage===pages}));
  const info=document.createElement('span'); info.className='info'; info.textContent=`第 ${currentPage}/${pages} 页`; p.appendChild(info);
}

// ---------- UI 同步 ----------
function syncDirUI(){
  document.querySelectorAll('#sortDir button').forEach(b=>{
    b.classList.toggle('on', b.dataset.dir===state.sortDir);
  });
}

// ---------- 初始化 ----------
async function init(){
  buildThresholds();
  // 排序方向
  document.querySelectorAll('#sortDir button').forEach(b=>{
    b.onclick=()=>{ state.sortDir=b.dataset.dir; syncDirUI(); apply(); };
  });
  $('sortField').onchange=()=>{ state.sortField=$('sortField').value; apply(); };
  // 企业属性
  document.querySelectorAll('#soeGrp button').forEach(b=>{
    b.onclick=()=>{
      document.querySelectorAll('#soeGrp button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); state.soe=b.dataset.soe; apply();
    };
  });
  $('applyBtn').onclick=apply;
  $('resetBtn').onclick=()=>{
    state.sortField='total'; state.sortDir='desc'; state.soe='';
    state.thresholds={peSc:0,pbSc:0,divSc:0,ncSc:0,atSc:0,roSc:0,paSc:0,cfSc:0,fwdSc:-10};
    $('sortField').value='total'; syncDirUI();
    document.querySelectorAll('#soeGrp button').forEach((x,i)=>x.classList.toggle('on',i===0));
    document.querySelectorAll('#thresholds input').forEach(inp=>{ inp.value='0'; inp.nextElementSibling.textContent='0'; });
    apply();
  };
  // 若 URL 带 ?focus=filter 高亮筛选面板
  if(location.search.includes('focus=filter')){
    $('filterPanel').scrollIntoView({behavior:'smooth',block:'start'});
    $('filterPanel').style.boxShadow='0 0 0 3px rgba(37,99,235,.35)';
  }
  try{
    const res=await fetch('all.json?v=202608102107', { cache:'no-cache' });
    ALL=await res.json();
    apply();
  }catch(e){
    $('tableWrap').innerHTML='<div class="loading">数据加载失败，请刷新重试。</div>';
  }
}
init();

// ----- 前瞻股息率可信度说明（点击股息率列的红色标记弹出）-----
function openDivWarnAll(code){
  const e = (ALL && ALL.length) ? ALL.find(x => x.code === code) : null;
  if(!e) return;
  const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  document.getElementById('divwarn-title').textContent = '前瞻股息率可信度说明';
  document.getElementById('divwarn-sub').innerHTML = esc(e.name) + '（' + esc(e.code) + '）';
  const rows = [
    ['前瞻股息率', (e.divY!=null? e.divY.toFixed(2)+'%' : '—') + (e.trailDiv>0? '（TTM 股息率 '+e.trailDiv.toFixed(2)+'%）' : (e.trailDiv===0? '（TTM 未分红）':''))],
    ['预估全年归母净利', e.fwdEstNp!=null? e.fwdEstNp+' 亿元（按去年同期节奏外推）' : '—'],
    ['去年派息率', e.fwdPayout!=null? e.fwdPayout.toFixed(0)+'%' : '—'],
    ['扣非 / 归母（TTM）', e.dedRatioTtm!=null? e.dedRatioTtm.toFixed(2) : '—'],
  ];
  let h = '<div class="dw-kv">' + rows.map(r=>'<span>'+esc(r[0])+'</span><b>'+esc(r[1])+'</b>').join('') + '</div>';
  h += '<div class="dw-why">为什么给出这个提示</div>';
  const reasons = e.divFwdReason ? e.divFwdReason.split('；') : [];
  h += reasons.map(r=>'<div class="dw-li">'+esc(r)+'</div>').join('');
  h += '<div class="dw-note">前瞻股息率 = 预估全年归母净利润 × 去年派息率 ÷ 当前市值，即"假设公司按去年的派息比例分配今年的预估利润"。'
     + '触发提示的条件（满足任一）：① 前瞻股息率 ≥10%（A 股常态不足 8%）；② 支撑股息的利润含大额非经常性损益（扣非/归母低于 0.6）且股息率 ≥6%；③ 前瞻股息率 ≥2.5 倍 TTM 股息率且 ≥8%。'
     + '本提示仅为数据可信度提醒，不构成投资建议。</div>';
  document.getElementById('divwarn-body').innerHTML = h;
  document.getElementById('divwarn-modal').style.display = 'flex';
}
function closeDivWarnAll(){ const m = document.getElementById('divwarn-modal'); if(m) m.style.display = 'none'; }
(function initDivWarnAll(){
  const c = document.getElementById('divwarn-close'); if(c) c.onclick = closeDivWarnAll;
  const m = document.getElementById('divwarn-modal'); if(m) m.onclick = (ev) => { if(ev.target === m) closeDivWarnAll(); };
})();
