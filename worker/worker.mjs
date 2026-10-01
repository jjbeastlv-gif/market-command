const ORIGIN = 'https://jjbeastlv-gif.github.io';
const MAX_SYMBOLS = 100;
const TTL = 10000;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type':'application/json', 'Cache-Control':'no-store', ...extra}
});
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = {'Access-Control-Allow-Origin':ORIGIN, 'Vary':'Origin',
      'Access-Control-Expose-Headers':'Retry-After', 'X-Content-Type-Options':'nosniff'};
    if (origin && origin !== ORIGIN) return json({error:'Origin not allowed'},403);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null,{status:204,
      headers:{...cors,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
    if (request.method !== 'GET') return json({error:'Read-only service. Trading disabled.'},405,cors);
    if (url.pathname === '/' || url.pathname === '/health') return json({
      service:'Market Command data',configured:!!(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY && env.QUOTE_GATE),
      feed:'iex',tradingEnabled:false,refreshSeconds:10,maxSymbols:MAX_SYMBOLS
    },200,cors);
    if (url.pathname !== '/quotes') return json({error:'Not found. Trading disabled.'},404,cors);
    const raw = (url.searchParams.get('symbols') || '').split(',');
    if (!raw.length || raw.length > MAX_SYMBOLS || raw.some(s => !/^[A-Z][A-Z0-9.\-]{0,15}$/.test(s)))
      return json({error:'Use 1–100 US stock/ETF tickers.'},400,cors);
    if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY || !env.QUOTE_GATE)
      return json({error:'Market data is not configured. Manual prices are preserved.'},503,cors);
    const symbols = [...new Set(raw)].sort().join(',');
    try {
      const gate = env.QUOTE_GATE.get(env.QUOTE_GATE.idFromName('alpaca-free-budget'));
      const result = await gate.fetch('https://internal/quotes?symbols='+encodeURIComponent(symbols));
      const headers = new Headers(result.headers);
      for (const [key,value] of Object.entries(cors)) headers.set(key,value);
      return new Response(result.body,{status:result.status,headers});
    } catch {
      return json({error:'Market data temporarily unavailable.'},502,cors);
    }
  }
};

// A single shared Durable Object enforces an aggregate budget across browsers
// and regions. No holdings, balances, or credentials are stored in this object.
export class QuoteGate {
  constructor(ctx,env) {
    this.ctx=ctx; this.env=env; this.cache=new Map(); this.pending=new Map();
    ctx.blockConcurrencyWhile(async()=> {
      this.budget=await ctx.storage.get('budget') || {requests:[],cooldown:0};
    });
  }
  async fetch(request) {
    const symbols=new URL(request.url).searchParams.get('symbols');
    if (!symbols || symbols.split(',').length>MAX_SYMBOLS ||
        symbols.split(',').some(s=>!/^[A-Z][A-Z0-9.\-]{0,15}$/.test(s)))
      return json({error:'Invalid symbols'},400);
    const now=Date.now(), entry=this.cache.get(symbols);
    if(entry && now-entry.at<TTL) return json(entry.body);
    if(this.pending.has(symbols)) return (await this.pending.get(symbols)).clone();
    const job=this.load(symbols);
    this.pending.set(symbols,job);
    try { return (await job).clone(); }
    finally { this.pending.delete(symbols); }
  }
  async load(symbols) {
    const now=Date.now();
    this.budget.requests=this.budget.requests.filter(t=>now-t<60000);
    if(now<this.budget.cooldown || this.budget.requests.length>=180) {
      const release=this.budget.requests.length>=180?this.budget.requests[0]+60000:now;
      const seconds=Math.max(1,Math.ceil((Math.max(this.budget.cooldown,release)-now)/1000));
      return json({error:'Provider budget reached. Retrying later.'},429,{'Retry-After':String(seconds)});
    }
    this.budget.requests.push(now);
    await this.ctx.storage.put('budget',{requests:[...this.budget.requests],cooldown:this.budget.cooldown});
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
    try {
      // Fixed data-only host and endpoint: this service cannot place orders.
      const response=await fetch('https://data.alpaca.markets/v2/stocks/snapshots?feed=iex&symbols='+encodeURIComponent(symbols),{
        headers:{'APCA-API-KEY-ID':this.env.ALPACA_API_KEY_ID,
          'APCA-API-SECRET-KEY':this.env.ALPACA_API_SECRET_KEY},
        signal:controller.signal
      });
      if(response.status===429) {
        this.budget.cooldown=Date.now()+60000;
        await this.ctx.storage.put('budget',{requests:[...this.budget.requests],cooldown:this.budget.cooldown});
        return json({error:'Alpaca rate limit. Retrying in 60 seconds.'},429,{'Retry-After':'60'});
      }
      if(!response.ok) return json({error:response.status===401||response.status===403?
        'Check Worker secrets and Alpaca IEX entitlement.':'Alpaca data unavailable.'},502);
      const data=await response.json(),quotes={};
      for(const symbol of symbols.split(',')) {
        const s=data[symbol], trade=s?.latestTrade;
        // Last trade price is used for valuation, never bid/ask midpoint.
        if(!trade || !Number.isFinite(trade.p) || trade.p<=0 ||
           !Number.isFinite(Date.parse(trade.t))) continue;
        const previous=s.prevDailyBar?.c;
        quotes[symbol]={price:trade.p,timestamp:trade.t,
          bid:Number.isFinite(s.latestQuote?.bp)?s.latestQuote.bp:null,
          ask:Number.isFinite(s.latestQuote?.ap)?s.latestQuote.ap:null,
          changePercent:Number.isFinite(previous)&&previous>0?(trade.p/previous-1)*100:null};
      }
      const body={feed:'iex',fetchedAt:new Date().toISOString(),tradingEnabled:false,quotes,
        missing:symbols.split(',').filter(s=>!quotes[s])};
      if(this.cache.size>=50) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(symbols,{at:Date.now(),body});
      return json(body);
    } catch { return json({error:'Market data request failed. Manual prices are preserved.'},502); }
    finally { clearTimeout(timeout); }
  }
}
