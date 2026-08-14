// 持股框页面：显示买入价、当前价、上涨百分比（可编辑）、实时目标卖出价，超价提醒，已卖出→回到标记框
// 盈利分析：每只持仓 = 总仓位 × 2%；计算股数/市值/收益率/今日盈亏；绘制组合累计收益率曲线；每 15 秒随行情更新
(function(){
  'use strict';
  async function fetchGz(url){
    const r = await fetch(url, { cache:'no-cache' });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    const txt = await new Response(stream).text();
    return JSON.parse(txt);
  }
  async function fetchKline(code){
    const today = new Date().toISOString().slice(0,10);
    const defs = {
      daily:   { period:'day',   start:'2024-01-01', count:800, key:'qfqday' },
      weekly:  { period:'week',  start:'2022-01-01', count:400, key:'qfqweek' },
      monthly: { period:'month', start:'2020-01-01', count:200, key:'qfqmonth' }
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
  var holdPrices = {};   // code -> 现价（实时）
  var holdPrevClose = {}; // code -> 昨收（实时，来自腾讯行情 parts[4]）
  var klineCache = {};   // code -> {dates:[], closes:[]}（日K，时间升序）

  function weight(){ return 0.02; } // 每只持仓占总仓位 2%

  function sellTarget(it){
    var pct = (it.sellPct != null ? it.sellPct : 5);
    return it.buyPrice * (1 + pct / 100);
  }

  function fmt(n){ if(n == null || isNaN(n)) return '0'; return Math.round(n).toLocaleString('en-US'); }

  // 取某持仓的"有效现价"：优先实时，其次日K最新收盘，再其次买入价
  function effPrice(code, it){
    if(holdPrices[code] != null) return holdPrices[code];
    var k = klineCache[code];
    if(k && k.closes.length) return k.closes[k.closes.length - 1];
    return it.buyPrice;
  }

  // 是否“今天”才买入（按买入时间戳的日期对比今天）
  function boughtToday(it){
    if(!it.buyAt) return false;
    var d = new Date(it.buyAt);
    function p(x){ return (x < 10 ? '0' : '') + x; }
    var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return s === todayStr();
  }

  // 今日盈亏：
  //  - 今天才买入的持仓 → 以“买入价”为基准（隔夜跳空缺口不该算在头上）：现价 - 买入价
  //  - 更早买入的持仓   → 以“昨收”为基准（实时行情 parts[4]；缺失时退回快照前一收盘）：现价 - 昨收
  function todayProfitOf(it, shares, price){
    if(boughtToday(it)){
      var ref = it.buyPrice;
      return { pnl: shares * (price - ref), pct: ref ? (price / ref - 1) * 100 : 0 };
    }
    var pc = holdPrevClose[it.code];
    var k = klineCache[it.code];
    if(pc == null && k && k.closes.length >= 2) pc = k.closes[k.closes.length - 2];
    if(pc == null) return { pnl: 0, pct: 0 };
    return { pnl: shares * (price - pc), pct: (price / pc - 1) * 100 };
  }

  // ---- 数据：加载每只持仓的日K（仅首次，缓存）----
  async function ensureKline(code){
    if(klineCache[code]) return klineCache[code];
    try{
      // K线改为实时拉腾讯（部署分桶不再烘焙 K线，体积过大导致上传 504）
      var arr = await fetchKline(code);
      var dl = (arr && arr.daily) || [];
      if(!dl.length) return null;
      if(dl[0][0] > dl[dl.length - 1][0]) dl = dl.slice().reverse(); // 转时间升序（最旧在左、最新在右）
      klineCache[code] = { dates: dl.map(function(x){ return x[0]; }), closes: dl.map(function(x){ return x[1]; }) };
      return klineCache[code];
    }catch(e){ return null; }
  }
  async function ensureAllKlines(){
    var list = WS.getHold();
    await Promise.all(list.map(function(it){ return ensureKline(it.code); }));
  }

  // ---- 汇总计算 ----
  function computeRows(){
    var capital = WS.getCapital();
    var list = WS.getHold();
    var rows = [];
    var invested = 0, mvTotal = 0, pnlTotal = 0, todayTotal = 0;
    list.forEach(function(it){
      var shares = Math.round(weight() * capital / it.buyPrice);
      var cost = weight() * capital;            // 该持仓投入本金（=总仓位×2%）
      var price = effPrice(it.code, it);
      var mv = shares * price;
      var pnl = mv - cost;
      var ret = (price / it.buyPrice - 1) * 100;
      var tp = todayProfitOf(it, shares, price);
      var todayPnl = tp.pnl, todayPct = tp.pct;
      rows.push({ it: it, shares: shares, cost: cost, price: price, mv: mv, pnl: pnl, ret: ret, todayPnl: todayPnl, todayPct: todayPct });
      invested += cost; mvTotal += mv; pnlTotal += pnl; todayTotal += todayPnl;
    });
    return {
      capital: capital, rows: rows, invested: invested, cash: capital - invested,
      mvTotal: mvTotal, pnlTotal: pnlTotal, todayTotal: todayTotal,
      retTotal: capital ? pnlTotal / capital * 100 : 0,
      todayPctTotal: capital ? todayTotal / capital * 100 : 0
    };
  }

  function renderSummary(){
    var s = computeRows();
    var cards = [
      { label: '持仓数', val: s.rows.length + ' 只' },
      { label: '总仓位', val: '¥' + fmt(s.capital) },
      { label: '投入本金', val: '¥' + fmt(s.invested) },
      { label: '当前组合市值', val: '¥' + fmt(s.capital + s.pnlTotal) },
      { label: '累计收益率', val: (s.retTotal >= 0 ? '+' : '') + s.retTotal.toFixed(2) + '%', cls: s.retTotal >= 0 ? 'up' : 'down' },
      { label: '今日收益', val: (s.todayTotal >= 0 ? '+' : '') + '¥' + fmt(Math.abs(s.todayTotal)), cls: s.todayTotal >= 0 ? 'up' : 'down' }
    ];
    var el = document.getElementById('profit-cards');
    if(el) el.innerHTML = cards.map(function(c){
      return '<div class="pcard"><div class="pcard-label">' + c.label + '</div><div class="pcard-val ' + (c.cls || '') + '">' + c.val + '</div></div>';
    }).join('');
  }

  function setChartNote(t){ var el = document.getElementById('profit-chart-note'); if(el) el.textContent = t || ''; }
  function clearChart(){
    var svg = document.getElementById('profit-chart');
    if(svg) svg.innerHTML = '<text x="400" y="130" text-anchor="middle" fill="#888" font-size="12">暂无数据</text>';
  }

  // 曲线起点（固定为“今天”，不随快照滑动）：首次运行按数据最新快照日写入，之后保持不变
  function todayStr(){
    var n = new Date();
    function p(x){ return (x < 10 ? '0' : '') + x; }
    return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate());
  }
  function getCurveStart(){
    var s = null;
    try { s = localStorage.getItem('sz_curve_start'); } catch(e){}
    if(s) return s;
    var maxDate = null;
    Object.keys(klineCache).forEach(function(code){
      var k = klineCache[code];
      if(k && k.dates.length){ var d = k.dates[k.dates.length - 1]; if(!maxDate || d > maxDate) maxDate = d; }
    });
    var start = maxDate || todayStr();
    try { localStorage.setItem('sz_curve_start', start); } catch(e){}
    return start;
  }

  // ---- 收益率曲线（按总仓位等权：每只 2% 权重；自“今天”起逐日累积，不回溯过往）----
  function renderCurve(){
    var list = WS.getHold();
    var svg = document.getElementById('profit-chart');
    if(!svg) return;
    if(list.length < 1){ setChartNote('暂无持仓，无法绘制收益率曲线'); clearChart(); return; }
    var start = getCurveStart();
    var tStr = todayStr();
    var valid = [];
    list.forEach(function(it){
      var k = klineCache[it.code];
      if(!k) return;
      var closes = k.closes.slice();
      var dates = k.dates.slice();
      // 仅用“今天”当日的实时价替换（不拿实时价去覆盖未来的收盘点）
      var tIdx = -1;
      for(var i = 0; i < dates.length; i++){ if(dates[i] === tStr){ tIdx = i; break; } }
      if(tIdx >= 0 && holdPrices[it.code] != null) closes[tIdx] = holdPrices[it.code];
      // 截取到起点（今天）及之后：不回溯过往
      var idx = dates.length;
      for(var j = 0; j < dates.length; j++){ if(dates[j] >= start){ idx = j; break; } }
      if(idx >= dates.length) idx = Math.max(0, dates.length - 1); // 快照滞后时至少保留最新点
      closes = closes.slice(idx);
      dates = dates.slice(idx);
      valid.push({ it: it, closes: closes, dates: dates });
    });
    if(!valid.length){ setChartNote('日K数据缺失，暂无法绘制（每日快照后自动补全）'); clearChart(); return; }
    var L = Math.min.apply(null, valid.map(function(v){ return v.closes.length; }));
    valid.forEach(function(v){ v.closes = v.closes.slice(-L); });
    var dates = valid[0].dates.slice(-L);
    // 基准用「买入价（成本）」：使曲线末点与上方「累计收益率」(相对总仓位、以买入价为成本) 完全同口径。
    // 曲线左端(今天)不再强制为 0%，而是“自买入至今”的累计收益率；0% 参考线仍居中。
    var capital = WS.getCapital();
    var baseAcc = 0;
    valid.forEach(function(v){ baseAcc += weight() * v.it.buyPrice / v.it.buyPrice; }); // = weight() × N（投入本金占比）
    var baseValue = baseAcc * capital; // 以买入价计的组合市值
    var rets = [];
    for(var k = 0; k < L; k++){
      var acc = 0;
      for(var i = 0; i < valid.length; i++){
        acc += weight() * valid[i].closes[k] / valid[i].it.buyPrice;
      }
      var pv = acc * capital;
      // 与上方「累计收益率」对齐：相对总仓位（含空仓）的盈亏率，而非仅持仓部分的市值比率
      rets.push((pv - baseValue) / capital * 100);
    }
    drawReturnCurve(rets, dates);
    var last = rets[rets.length - 1];
    if(L <= 1){
      setChartNote('收益率曲线自 ' + start + '（今天）起逐日累积；每日收盘快照更新后自动向右延伸（当前仅含今日）');
    } else {
      setChartNote('自 ' + start + ' 起累计收益率 ' + (last >= 0 ? '+' : '') + last.toFixed(2) + '% · 基于 ' + valid.length + ' 只持仓日K（' + L + ' 个交易日）');
    }
  }

  function drawReturnCurve(rets, dates){
    var svg = document.getElementById('profit-chart');
    if(!svg) return;
    var W = 800, H = 260, PAD = { l: 50, r: 16, t: 14, b: 28 };
    svg.innerHTML = '';
    if(!rets || !rets.length){
      svg.insertAdjacentHTML('beforeend', '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="#888" font-size="12">暂无数据，无法绘制曲线</text>');
      return;
    }
    var chartW = W - PAD.l - PAD.r, chartH = H - PAD.t - PAD.b;
    // 对称区间：0% 固定位于垂直中线，幅度随曲线偏移自动放大（±absMax）
    var absMax = 1; // 至少 ±1%，避免单一极小点导致比例失真
    rets.forEach(function(v){ var a = Math.abs(v); if(a > absMax) absMax = a; });
    var min = -absMax, max = absMax, range = max - min;
    function yOf(v){ return PAD.t + chartH - ((v - min) / range) * chartH; }
    var zeroY = yOf(0); // 中线
    var stepX = rets.length > 1 ? chartW / (rets.length - 1) : 0;
    // 网格 + y 轴（偶数 grid → 0 落在中线并被加粗）
    var grid = 4;
    for(var i = 0; i <= grid; i++){
      var y = PAD.t + chartH * i / grid;
      var val = max - range * i / grid;
      var isZero = Math.abs(val) < 1e-9;
      svg.insertAdjacentHTML('beforeend', '<line x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + y + '" y2="' + y + '" stroke="' + (isZero ? '#b0b4bd' : '#eef0f3') + '"' + (isZero ? ' stroke-width="1.4"' : '') + '/>');
      svg.insertAdjacentHTML('beforeend', '<text x="' + (PAD.l - 6) + '" y="' + (y + 3) + '" text-anchor="end" fill="' + (isZero ? '#555' : '#999') + '" font-size="10">' + (val >= 0 ? '+' : '') + val.toFixed(1) + '%</text>');
    }
    // x 轴标签
    var xt = Math.min(rets.length, 5);
    for(var j = 0; j < xt; j++){
      var idx = Math.min(rets.length - 1, Math.floor(rets.length * j / Math.max(1, xt - 1)));
      var x = PAD.l + stepX * idx;
      var d = dates ? (dates[idx] || '') : '';
      var label = d.substring(5);
      var anchor = 'middle', lx = x;
      if(j === 0){ anchor = 'start'; lx = PAD.l; }
      else if(j === xt - 1){ anchor = 'end'; lx = W - PAD.r; }
      svg.insertAdjacentHTML('beforeend', '<text x="' + lx + '" y="' + (H - 6) + '" text-anchor="' + anchor + '" fill="#999" font-size="10">' + label + '</text>');
    }
    // 折线 + 面积（面积填充至零轴）
    var last = rets[rets.length - 1];
    var color = last >= 0 ? '#e34d4d' : '#1a9f4b'; // 红涨绿跌
    var path = '';
    for(var k = 0; k < rets.length; k++){
      var x = PAD.l + stepX * k;
      var y = yOf(rets[k]);
      path += (k === 0 ? 'M' : 'L') + x + ',' + y + ' ';
    }
    if(rets.length > 1){
      var lastX = PAD.l + stepX * (rets.length - 1);
      svg.insertAdjacentHTML('beforeend',
        '<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity=".28"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>');
      svg.insertAdjacentHTML('beforeend', '<path d="' + path + ' L' + lastX + ',' + zeroY + ' L' + PAD.l + ',' + zeroY + ' Z" fill="url(#pg)"/>');
      svg.insertAdjacentHTML('beforeend', '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.6"/>');
      // 末端标记
      var ly = yOf(last);
      svg.insertAdjacentHTML('beforeend', '<circle cx="' + lastX + '" cy="' + ly + '" r="3.5" fill="' + color + '"/>');
      svg.insertAdjacentHTML('beforeend', '<text x="' + lastX + '" y="' + (ly - 8) + '" text-anchor="end" fill="' + color + '" font-size="11" font-weight="700">' + (last >= 0 ? '+' : '') + last.toFixed(2) + '%</text>');
    } else {
      // 仅有“今天”一个点：中线基准 + 当日点（曲线将随每日快照向右延伸）
      var x0 = PAD.l, yv = yOf(rets[0]);
      svg.insertAdjacentHTML('beforeend', '<circle cx="' + x0 + '" cy="' + yv + '" r="3.5" fill="' + color + '"/>');
      svg.insertAdjacentHTML('beforeend', '<text x="' + (x0 + 6) + '" y="' + (yv - 6) + '" fill="' + color + '" font-size="11" font-weight="700">' + (rets[0] >= 0 ? '+' : '') + rets[0].toFixed(2) + '%</text>');
      if(dates && dates[0]) svg.insertAdjacentHTML('beforeend', '<text x="' + PAD.l + '" y="' + (H - 6) + '" fill="#999" font-size="10">' + dates[0].substring(5) + '</text>');
    }
  }

  // ---- 持股表 ----
  function renderHold(){
    var root = document.getElementById('hold-list');
    var sumEl = document.getElementById('hold-sum');
    if(!root) return;
    var list = WS.getHold();
    var cntEl = document.getElementById('hold-count');
    if(cntEl) cntEl.textContent = list.length;
    // 迁移：旧数据若无 sellPct，则从原 targetSell 反推
    list.forEach(function(it){
      if(it.sellPct == null && it.targetSell != null && it.buyPrice){
        it.sellPct = Math.round(((it.targetSell / it.buyPrice - 1) * 100) * 10) / 10;
        it.targetSell = Math.round(sellTarget(it) * 100) / 100;
      }
      if(it.sellPct == null) it.sellPct = 5;
    });
    WS.setHold(list);
    if(!list.length){
      root.innerHTML = '<div class="empty-tip">持股框为空。在「全部公司」评分页点 ☆ 加入标记框并点击「买入」后，股票会出现在这里。</div>';
      if(sumEl) sumEl.textContent = '';
      renderSummary(); renderCurve();
      return;
    }
    var capital = WS.getCapital();
    var html = '<table class="hold-table"><thead><tr>'
      + '<th>公司</th><th>买入价</th><th>当前价</th><th>股数</th><th>市值</th><th>收益率</th><th>今日</th><th>上涨%</th><th>目标卖出价</th><th>提醒</th><th>操作</th>'
      + '</tr></thead><tbody>';
    for(var i = 0; i < list.length; i++){
      var it = list[i];
      var tgt = sellTarget(it);
      var shares = Math.round(weight() * capital / it.buyPrice);
      var price = effPrice(it.code, it);
      var mv = shares * price;
      var ret = (price / it.buyPrice - 1) * 100;
      var tp = todayProfitOf(it, shares, price);
      var todayPnl = tp.pnl, todayPct = tp.pct;
      var retCls = ret >= 0 ? 'up' : 'down';
      var todayCls = todayPnl >= 0 ? 'up' : 'down';
      html += '<tr data-code="' + it.code + '">'
        + '<td><strong>' + it.name + '</strong><div class="code-sm">' + it.code.toUpperCase() + '</div></td>'
        + '<td class="price-cell">¥' + it.buyPrice.toFixed(2) + '</td>'
        + '<td class="price-cell" id="hp-' + it.code + '">¥' + price.toFixed(2) + '</td>'
        + '<td class="num-cell">' + shares.toLocaleString('en-US') + '</td>'
        + '<td class="price-cell" id="hmv-' + it.code + '">¥' + mv.toFixed(0) + '</td>'
        + '<td class="price-cell ' + retCls + '" id="hret-' + it.code + '">' + (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%</td>'
        + '<td class="price-cell ' + todayCls + '" id="htoday-' + it.code + '">' + (todayPnl >= 0 ? '+' : '') + '¥' + Math.abs(todayPnl).toFixed(0)
          + '<div class="code-sm">' + (todayPct >= 0 ? '+' : '') + todayPct.toFixed(2) + '%</div></td>'
        + '<td><input type="number" step="0.1" min="0" value="' + it.sellPct + '" data-code="' + it.code + '" class="sell-pct-input"></td>'
        + '<td class="price-cell" style="color:var(--orange-fg)" id="hs-' + it.code + '">¥' + tgt.toFixed(2) + '</td>'
        + '<td id="ha-' + it.code + '"></td>'
        + '<td><button class="mini-btn danger" data-act="sell" data-code="' + it.code + '">已卖出</button></td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
    // 提醒
    list.forEach(function(it){
      var price = holdPrices[it.code];
      var ae = document.getElementById('ha-' + it.code);
      if(ae){
        var tgt = sellTarget(it);
        ae.innerHTML = (price != null && price >= tgt) ? '<span class="alert-sell">已达卖出目标 · 提醒卖出</span>' : '';
      }
    });
    root.querySelectorAll('button[data-act="sell"]').forEach(function(b){
      b.onclick = function(){
        WS.sell(b.dataset.code);
        renderHold();
        if(window.__renderWatch) window.__renderWatch();
      };
    });
    root.querySelectorAll('.sell-pct-input').forEach(function(inp){
      inp.addEventListener('change', function(){
        var code = inp.dataset.code;
        var v = parseFloat(inp.value);
        if(!(v >= 0)) return;
        var tgt = WS.setSellPct(code, v);
        var hs = document.getElementById('hs-' + code);
        if(hs && tgt != null) hs.textContent = '¥' + tgt.toFixed(2);
      });
    });
    renderSummary();
    renderCurve();
  }
  window.__renderHold = renderHold;

  // 每 15 秒：仅更新动态单元格，避免重建表格导致输入框失焦
  function updateDynamic(){
    var list = WS.getHold();
    var capital = WS.getCapital();
    list.forEach(function(it){
      var price = holdPrices[it.code];
      var el = document.getElementById('hp-' + it.code);
      if(el && price != null) el.textContent = '¥' + price.toFixed(2);
      var shares = Math.round(weight() * capital / it.buyPrice);
      var p = effPrice(it.code, it);
      var mv = shares * p;
      var ret = (p / it.buyPrice - 1) * 100;
      var mvel = document.getElementById('hmv-' + it.code);
      if(mvel) mvel.textContent = '¥' + mv.toFixed(0);
      var rel = document.getElementById('hret-' + it.code);
      if(rel){ rel.textContent = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%'; rel.className = 'price-cell ' + (ret >= 0 ? 'up' : 'down'); }
      var tp = todayProfitOf(it, shares, p);
      var te = document.getElementById('htoday-' + it.code);
      if(te){ te.innerHTML = (tp.pnl >= 0 ? '+' : '') + '¥' + Math.abs(tp.pnl).toFixed(0) + '<div class="code-sm">' + (tp.pct >= 0 ? '+' : '') + tp.pct.toFixed(2) + '%</div>'; te.className = 'price-cell ' + (tp.pnl >= 0 ? 'up' : 'down'); }
      var ae = document.getElementById('ha-' + it.code);
      if(ae && price != null){ var tgt = sellTarget(it); ae.innerHTML = (price >= tgt) ? '<span class="alert-sell">已达卖出目标 · 提醒卖出</span>' : ''; }
    });
    renderSummary();
    renderCurve();
  }

  async function refreshHoldPrices(){
    var list = WS.getHold();
    if(!list.length) return;
    var codes = list.map(function(x){ return x.code; });
    var q = await WS.fetchQuotes(codes);
    for(var i = 0; i < codes.length; i++){
      var code = codes[i];
      var rec = q[code];
      if(rec){
        if(rec.price != null) holdPrices[code] = rec.price;
        if(rec.prevClose != null) holdPrevClose[code] = rec.prevClose;
      }
    }
    updateDynamic();
  }

  // 总仓位输入
  var capInput = document.getElementById('capital-input');
  if(capInput){
    capInput.value = WS.getCapital();
    capInput.addEventListener('change', function(){
      var v = Math.max(0, parseFloat(capInput.value) || 0);
      WS.setCapital(v);
      renderHold(); // 总仓位变化影响股数/市值/曲线，整体重算
    });
  }

  renderHold();
  ensureAllKlines().then(function(){ renderHold(); }); // 日K加载完成后刷新"今日"与曲线
  refreshHoldPrices();
  setInterval(refreshHoldPrices, 15000);
})();

// ----- 持股框 导出/导入（换网址/清缓存时恢复本地数据） -----
(function(){
  function download(filename, text){
    var blob = new Blob([text], {type:'application/json'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  var expBtn = document.getElementById('hold-export');
  var impBtn = document.getElementById('hold-import');
  var impFile = document.getElementById('hold-import-file');
  if(expBtn) expBtn.onclick = function(){
    var data = { type:'hold', version:1, exportedAt: new Date().toISOString(),
                 capital: WS.getCapital(), data: WS.getHold() };
    download('hold_backup.json', JSON.stringify(data, null, 2));
  };
  if(impBtn && impFile) impBtn.onclick = function(){ impFile.click(); };
  if(impFile) impFile.onchange = function(){
    var f = impFile.files && impFile.files[0]; if(!f) return;
    var rd = new FileReader();
    rd.onload = function(){
      try{
        var obj = JSON.parse(rd.result);
        var arr = Array.isArray(obj) ? obj : (obj.data || obj.hold);
        if(!Array.isArray(arr)) throw new Error('文件格式不对（缺少 data 数组）');
        if(!confirm('将用导入的 ' + arr.length + ' 条覆盖当前持股框，确定？')){ impFile.value=''; return; }
        WS.setHold(arr);
        if(obj.capital != null) WS.setCapital(obj.capital);
        renderHold();
        if(typeof refreshHoldPrices === 'function') refreshHoldPrices();
        alert('持股框已导入 ' + arr.length + ' 条');
      }catch(err){ alert('导入失败：' + err.message); }
      impFile.value = '';
    };
    rd.readAsText(f);
  };
})();

// ----- 持股框 云端备份/恢复（Netlify Function + Blobs，点一下即存，无需发助手） -----
(function(){
  var CLOUD_API = '/.netlify/functions/backup';
  var backupBtn = document.getElementById('hold-cloud-backup');
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
  var restoreBtn = document.getElementById('hold-cloud-restore');
  if(restoreBtn) restoreBtn.onclick = function(){
    fetch(CLOUD_API, { cache:'no-cache' }).then(function(r){ if(!r.ok) throw new Error('云端暂无备份'); return r.json(); })
      .then(function(obj){
        var arr = Array.isArray(obj) ? obj : (obj.hold || obj.data || []);
        if(!Array.isArray(arr)) throw new Error('云端备份格式不对');
        if(!confirm('将用云端备份覆盖当前持股框（' + arr.length + ' 条），确定？')) return;
        WS.setHold(arr);
        if(obj.capital != null) WS.setCapital(obj.capital);
        renderHold();
        if(typeof refreshHoldPrices === 'function') refreshHoldPrices();
        alert('已从云端恢复持股框 ' + arr.length + ' 条');
      }).catch(function(e){ alert('云端恢复失败：' + e.message); });
  };
})();
