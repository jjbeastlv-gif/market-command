import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{QuoteGate} from './worker.mjs';
function context(budget){
  const saved=new Map(budget?[['budget',budget]]:[]);
  let ready;
  return {storage:{get:async k=>saved.get(k),put:async(k,v)=>saved.set(k,structuredClone(v))},
    blockConcurrencyWhile(fn){ready=fn()},get ready(){return ready},saved};
}
test('read-only routes, origin checks, input limits, and unconfigured health',async()=>{
  assert.equal((await worker.fetch(new Request('https://test/orders',{method:'POST'}),{})).status,405);
  assert.equal((await worker.fetch(new Request('https://test/orders'),{})).status,404);
  assert.equal((await worker.fetch(new Request('https://test/quotes?symbols=AAPL',{headers:{Origin:'https://evil.example'}}),{})).status,403);
  assert.equal((await worker.fetch(new Request('https://test/quotes?symbols=AAPL,https://evil'),{})).status,400);
  assert.equal((await worker.fetch(new Request('https://test/quotes?symbols=AAPL'),{})).status,503);
  const health=await (await worker.fetch(new Request('https://test/health'),{})).json();
  assert.equal(health.tradingEnabled,false);assert.equal(health.configured,false);
});
test('cache, coalescing, sanitization, and fixed IEX data-only upstream',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.ok(url.startsWith('https://data.alpaca.markets/v2/stocks/snapshots?feed=iex'));
    assert.equal(options.headers['APCA-API-SECRET-KEY'],'test-secret');
    await new Promise(resolve=>setTimeout(resolve,5));
    return Response.json({AAPL:{latestTrade:{p:200,t:new Date().toISOString()},prevDailyBar:{c:100}},
      NVDA:{latestTrade:{p:-1,t:'invalid'}}});
  };
  try{
    const ctx=context(),gate=new QuoteGate(ctx,{ALPACA_API_KEY_ID:'test-key',ALPACA_API_SECRET_KEY:'test-secret'});
    await ctx.ready;
    const req=new Request('https://internal/quotes?symbols=AAPL,NVDA');
    const results=await Promise.all([gate.fetch(req),gate.fetch(req)]);
    assert.equal(calls,1);
    for(const result of results){
      const data=await result.json();assert.equal(data.quotes.AAPL.price,200);
      assert.equal(data.quotes.AAPL.changePercent,100);assert.deepEqual(data.missing,['NVDA']);
      assert.equal(JSON.stringify(data).includes('test-secret'),false);
    }
    assert.equal((await gate.fetch(req)).status,200);assert.equal(calls,1);
  }finally{globalThis.fetch=old}
});
test('rolling aggregate budget survives restart and avoids upstream calls',async()=>{
  const ctx=context({requests:Array(180).fill(Date.now()-1000),cooldown:0});
  const gate=new QuoteGate(ctx,{});await ctx.ready;
  const response=await gate.fetch(new Request('https://internal/quotes?symbols=AAPL'));
  assert.equal(response.status,429);assert.ok(Number(response.headers.get('Retry-After'))>0);
});
test('provider cooldown persisted without leaking errors or credentials',async()=>{
  const old=globalThis.fetch;globalThis.fetch=async()=>new Response('SECRET BODY',{status:429});
  try{
    const ctx=context(),gate=new QuoteGate(ctx,{});await ctx.ready;
    const result=await gate.fetch(new Request('https://internal/quotes?symbols=AAPL'));
    assert.equal(result.status,429);assert.equal((await result.text()).includes('SECRET'),false);
    const restarted=new QuoteGate(ctx,{});await ctx.ready;
    assert.equal((await restarted.fetch(new Request('https://internal/quotes?symbols=SPY'))).status,429);
  }finally{globalThis.fetch=old}
});
