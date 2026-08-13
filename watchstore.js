// 收藏 / 持股 共享存储层（纯前端 localStorage，无后端；与主页/持股框同源共享）
(function(){
  'use strict';
  var WS_WATCH = 'sz_watch';   // 标记框（拟买入）：[{code,name,targetBuy}]
  var WS_HOLD  = 'sz_hold';    // 持股框：[{code,name,buyPrice,targetSell,buyAt}]
  var WS_CAPITAL = 'sz_capital'; // 盈利分析总仓位（本金），每只持仓 = 总仓位 × 2%

  // 总仓位（本金）；默认 ¥1,000,000
  function getCapital(){ var v = parseFloat(localStorage.getItem(WS_CAPITAL)); return (v > 0) ? Math.round(v) : 1000000; }
  function setCapital(v){ try{ if(v > 0) localStorage.setItem(WS_CAPITAL, String(Math.round(v))); }catch(e){} }

  function read(key){ try{ return JSON.parse(localStorage.getItem(key)) || []; }catch(e){ return []; } }
  function write(key, arr){ try{ localStorage.setItem(key, JSON.stringify(arr)); }catch(e){} }

  function getWatch(){ return read(WS_WATCH); }
  function setWatch(a){ write(WS_WATCH, a); }
  function getHold(){ return read(WS_HOLD); }
  function setHold(a){ write(WS_HOLD, a); }

  function isWatched(code){ return getWatch().some(function(x){ return x.code === code; }); }

  // 切换收藏；返回 true=已加入，false=已移除
  function toggleWatch(code, name){
    var a = getWatch();
    var i = a.findIndex(function(x){ return x.code === code; });
    if(i >= 0){ a.splice(i, 1); setWatch(a); return false; }
    a.unshift({ code: code, name: name || code, targetBuy: null }); // 新标记置顶（标记框第一行）
    setWatch(a); return true;
  }

  // 已存在标记框时，把它提到第一行（搜索/选中该公司时调用，方便定位）
  function promoteWatch(code){
    var a = getWatch();
    var i = a.findIndex(function(x){ return x.code === code; });
    if(i <= 0) return; // 不存在或已是第一行
    var it = a.splice(i, 1)[0];
    a.unshift(it);
    setWatch(a);
  }

  // 买入：从标记框移到持股框；目标卖出价按"上涨百分比"实时计算（默认 +5%）
  function buy(code, buyPrice){
    var a = getWatch();
    var it = a.find(function(x){ return x.code === code; });
    if(!it) return false;
    buyPrice = Math.round(buyPrice * 100) / 100;
    var sellPct = 5; // 默认上涨 5% 作为目标卖出
    var targetSell = Math.round(buyPrice * (1 + sellPct / 100) * 100) / 100;
    var hold = getHold();
    if(!hold.some(function(x){ return x.code === code; })){
      hold.push({ code: code, name: it.name, buyPrice: buyPrice, sellPct: sellPct, targetSell: targetSell, buyAt: Date.now() });
      setHold(hold);
    }
    setWatch(a.filter(function(x){ return x.code !== code; }));
    return true;
  }

  // 更新持股项的上涨百分比；返回重算后的目标卖出价
  function setSellPct(code, sellPct){
    var h = getHold();
    var it = h.find(function(x){ return x.code === code; });
    if(!it) return null;
    it.sellPct = sellPct;
    it.targetSell = Math.round(it.buyPrice * (1 + sellPct / 100) * 100) / 100;
    setHold(h);
    return it.targetSell;
  }

  // 已卖出：从持股框移回标记框（保留原目标买入价留空）
  function sell(code){
    var h = getHold();
    var it = h.find(function(x){ return x.code === code; });
    if(!it) return false;
    var a = getWatch();
    if(!a.some(function(x){ return x.code === code; })){
      a.unshift({ code: code, name: it.name, targetBuy: null }); // 回到标记框也置顶
      setWatch(a);
    }
    setHold(h.filter(function(x){ return x.code !== code; }));
    return true;
  }

  // 批量拉腾讯实时行情：支持逗号拼接多个代码，一次请求；
  // 返回 {code小写: {price: 现价, prevClose: 昨收}}
  function fetchQuotes(codes){
    if(!codes || !codes.length) return Promise.resolve({});
    var url = 'https://qt.gtimg.cn/q=' + codes.map(function(c){ return c.toLowerCase(); }).join(',');
    return fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.text(); })
      .then(function(t){
        var out = {};
        var re = /v_(\w+)="([^"]+)"/g, m;
        while((m = re.exec(t))){
          var parts = m[2].split('~');
          var p = parseFloat(parts[3]);   // 现价
          var pc = parseFloat(parts[4]);  // 昨收
          if(p > 0) out[m[1].toLowerCase()] = { price: p, prevClose: pc > 0 ? pc : null };
        }
        return out;
      })
      .catch(function(){ return {}; });
  }

  window.WS = {
    getWatch: getWatch, setWatch: setWatch,
    getHold: getHold, setHold: setHold,
    getCapital: getCapital, setCapital: setCapital,
    isWatched: isWatched, toggleWatch: toggleWatch, promoteWatch: promoteWatch,
    buy: buy, sell: sell, setSellPct: setSellPct, fetchQuotes: fetchQuotes
  };
})();
