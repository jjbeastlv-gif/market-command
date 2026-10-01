'use strict';
const DATA_API='https://market-command-api.jjbeastlv.workers.dev';
let quoteTimer=null,quoteBusy=false,autoQuotes=true,quoteFailures=0,nextQuoteAt=0;
let connectionStatus='Waiting for data',lastFetched=null,requestedSymbols='';
function priceOf(position){return quotes[position.symbol]?.price ?? num(position.price)}
function priceLabel(symbol){
  const q=quotes[symbol];
  if(!q)return 'Manual / no IEX trade';
  const age=Date.now()-Date.parse(q.timestamp);
  return 'IEX last trade · '+(age>120000?'stale · ':'')+new Date(q.timestamp).toLocaleString();
}
function paintQuoteStatus(){
  $('data-status').textContent=connectionStatus;
  const count=db.positions.filter(p=>quotes[p.symbol]).length;
  $('overview-price-status').textContent=count+' / '+db.positions.length+' holdings priced from IEX';
  $('price-time').textContent=lastFetched?'Data checked '+new Date(lastFetched).toLocaleTimeString():'Manual prices';
  document.querySelectorAll('[data-watch-quote]').forEach(el=>{
    const symbol=el.dataset.watchQuote,q=quotes[symbol];
    el.textContent=q?fmt(q.price)+' · '+(q.changePercent===null?'':pct(q.changePercent)+' vs prior IEX close · ')+priceLabel(symbol):
      'No IEX trade available · chart below is independent';
  });
}
function quoteSymbols(){return [...new Set([...db.positions,...db.watch].map(x=>x.symbol))]
  .filter(s=>/^[A-Z][A-Z0-9.\-]{0,15}$/.test(s)).slice(0,100)}
function scheduleQuotes(){
  clearTimeout(quoteTimer);
  if(autoQuotes&&!document.hidden)quoteTimer=setTimeout(refreshQuotes,Math.max(0,nextQuoteAt-Date.now()));
}
function requestQuoteRefresh(){
  // Debounce edits and prevent manual clicks bypassing retry/rate-limit delays.
  clearTimeout(quoteTimer);
  if(autoQuotes&&!document.hidden)quoteTimer=setTimeout(refreshQuotes,Math.max(300,nextQuoteAt-Date.now()));
}
async function refreshQuotes(){
  if(quoteBusy)return;
  if(document.hidden){clearTimeout(quoteTimer);return}
  if(Date.now()<nextQuoteAt){scheduleQuotes();return}
  const symbols=quoteSymbols(),selection=symbols.join(',');
  if(!symbols.length){connectionStatus='Add a US stock/ETF to fetch prices';paintQuoteStatus();nextQuoteAt=Date.now()+10000;scheduleQuotes();return}
  quoteBusy=true;nextQuoteAt=Date.now()+10000;connectionStatus='Checking IEX prices';paintQuoteStatus();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(DATA_API+'/quotes?symbols='+encodeURIComponent(selection),{
      signal:controller.signal,credentials:'omit',cache:'no-store'
    });
    if(response.status===429){
      const retry=Math.min(3600,Math.max(60,Number(response.headers.get('Retry-After'))||60));
      nextQuoteAt=Date.now()+retry*1000;
      throw Error('Rate limited · retry in '+retry+' seconds');
    }
    if(!response.ok)throw Error('Data unavailable · keeping saved/manual prices');
    let data;
    try{data=await response.json()}catch{throw Error('Worker setup pending · keeping manual prices')}
    if(data.feed!=='iex'||data.tradingEnabled!==false||!data.quotes||typeof data.quotes!=='object')
      throw Error('Worker setup pending · keeping manual prices');
    // Do not apply a response for holdings removed/changed while it was in flight.
    const active=new Set(quoteSymbols());
    for(const symbol of Object.keys(quotes))if(!active.has(symbol))delete quotes[symbol];
    for(const symbol of symbols){
      if(!active.has(symbol))continue;
      const q=data.quotes[symbol],t=Date.parse(q?.timestamp);
      if(q&&Number.isFinite(q.price)&&q.price>0&&Number.isFinite(t)&&t<=Date.now()+60000){
        if(!quotes[symbol]||t>=Date.parse(quotes[symbol].timestamp))
          quotes[symbol]={price:q.price,timestamp:q.timestamp,
            changePercent:Number.isFinite(q.changePercent)?q.changePercent:null};
      }
    }
    lastFetched=new Date().toISOString();requestedSymbols=selection;quoteFailures=0;
    const total=new Set([...db.positions,...db.watch].map(x=>x.symbol)).size;
    const received=symbols.filter(s=>data.quotes[s]).length;
    connectionStatus='Connected · IEX '+received+'/'+symbols.length+
      (total>symbols.length?' · unsupported/excess tickers use manual prices':'');
    render();
  }catch(error){
    quoteFailures++;
    nextQuoteAt=Math.max(nextQuoteAt,Date.now()+Math.min(300000,10000*2**Math.min(quoteFailures,5)));
    connectionStatus=error.name==='AbortError'?'Request timed out · retrying':error.message;
    render();
  }finally{clearTimeout(timeout);quoteBusy=false;scheduleQuotes()}
}
function startQuotes(){
  $('refresh-quotes').onclick=()=>{if(Date.now()<nextQuoteAt)return toast('Waiting for the refresh/retry window');refreshQuotes()};
  $('toggle-quotes').onclick=()=>{
    autoQuotes=!autoQuotes;
    $('toggle-quotes').textContent=autoQuotes?'Pause auto refresh':'Resume auto refresh';
    if(autoQuotes)requestQuoteRefresh();else clearTimeout(quoteTimer);
  };
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)clearTimeout(quoteTimer);else if(autoQuotes)requestQuoteRefresh();
    paintQuoteStatus();
  });
  refreshQuotes();
}

window.addEventListener('storage',event=>{
  if(event.key!==KEY)return;
  try{
    const fresh=JSON.parse(event.newValue);
    if(!fresh||!Array.isArray(fresh.positions)||!Array.isArray(fresh.watch)||!Array.isArray(fresh.trades))return;
    db=fresh;const active=new Set(quoteSymbols());
    for(const symbol of Object.keys(quotes))if(!active.has(symbol))delete quotes[symbol];
    render();requestQuoteRefresh();
  }catch{}
});
