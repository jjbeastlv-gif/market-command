import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const initial={positions:[{id:'p1',symbol:'AAPL',shares:2,cost:100,price:150}],
  watch:[{id:'w1',symbol:'AAPL',note:'Keep this note'}],
  trades:[{id:'t1',symbol:'AAPL',date:'2026-09-01',side:'Closed trade',shares:1,price:100,pnl:10,notes:'Keep journal'}]};
function client(fetch){
  const elements=new Map(),listeners={},timers=new Map();let timerId=0,writes=0;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:({'risk-balance':'500','risk-percent':'1','risk-entry':'100','risk-stop':'95'})[id]||'',
      textContent:'',innerHTML:'',hidden:false,style:{},dataset:{},classList:{toggle(){}},
      append(){},replaceChildren(){},addEventListener(){},reset(){},scrollIntoView(){}});
    return elements.get(id);
  };
  const stored=new Map([['market-command-v2',JSON.stringify(initial)]]);
  const document={hidden:false,getElementById:element,querySelectorAll:()=>[],
    createElement:()=>element('created'),addEventListener:(type,fn)=>listeners[type]=fn};
  const context=vm.createContext({console,document,window:{scrollTo(){},addEventListener(){}},
    localStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>{writes++;stored.set(k,v)}},
    Date,Number,Set,Map,JSON,Math,AbortController,fetch,
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId},
    clearTimeout:id=>timers.delete(id),confirm:()=>false});
  vm.runInContext(readFileSync('quotes.js','utf8'),context);
  vm.runInContext(readFileSync('app.js','utf8'),context);
  return {context,elements,stored,listeners,timers,get writes(){return writes},document,
    run:code=>vm.runInContext(code,context)};
}
test('automatic quote overlay updates P/L without writing original saved records',async()=>{
  let calls=0;
  const c=client(async url=>{calls++;assert.match(url,/symbols=AAPL$/);return Response.json({
    feed:'iex',tradingEnabled:false,quotes:{AAPL:{price:200,timestamp:new Date().toISOString(),changePercent:2}}})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(c.elements.get('pvalue').textContent,'$400.00');
  assert.equal(c.elements.get('ppnl').textContent,'$200.00');
  assert.equal(c.writes,0);assert.deepEqual(JSON.parse(c.stored.get('market-command-v2')),initial);
  assert.equal(c.run('db.positions[0].price'),150);
  assert.ok([...c.timers.values()].some(t=>t.ms>=0&&t.ms<=10000));
  c.document.hidden=true;c.listeners.visibilitychange();assert.equal(c.timers.size,0);
});
test('undeployed Worker, invalid quotes, and outage preserve records with backoff',async()=>{
  const c=client(async()=>new Response('Hello World!'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.elements.get('pvalue').textContent,'$300.00');
  assert.match(c.elements.get('data-status').textContent,/Worker setup pending/);
  assert.equal(c.writes,0);
  assert.ok([...c.timers.values()].some(t=>t.ms>10000));
  c.context.fetch=async()=>Response.json({feed:'iex',tradingEnabled:false,quotes:{AAPL:{price:999,timestamp:'bad'}}});
  c.run('nextQuoteAt=0');await c.run('refreshQuotes()');
  assert.equal(c.elements.get('pvalue').textContent,'$300.00');
});
test('rate-limit clicks cannot bypass cooldown',async()=>{
  let calls=0;
  const c=client(async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}})});
  await new Promise(resolve=>setImmediate(resolve));
  c.elements.get('refresh-quotes').onclick();await c.run('refreshQuotes()');
  assert.equal(calls,1);assert.ok(c.run('nextQuoteAt-Date.now()')>110000);
});
