import test from 'node:test';
import assert from 'node:assert/strict';
import '../app/session-progress.js';
const { ProgressStore, identityKey } = globalThis.VirtualWorldSessionProgress;
const id = { connectionId:'default', providerKind:'openclaw', nativeOwnerId:'fixture', nativeSessionId:'agent:fixture:a' };
const response = (identity = id, revision = 1) => ({ schemaVersion:'vw-session-progress/v1', identity, availability:'supported', connectionEpoch:'e1', capabilities:{dismissCompleted:true}, card:{nativeRevision:revision,items:[{text:'one',status:'completed'}]} });
const flush = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
test('all identity dimensions isolate', () => {
  for (const key of Object.keys(id)) assert.notEqual(identityKey(id),identityKey({...id,[key]:'other'}));
});
test('same exact session coalesces viewers',async()=>{
  let resolve, calls=0;const store=new ProgressStore(()=>{calls++;return new Promise(r=>resolve=r);});
  let a,b;const ua=store.watch(id,s=>a=s),ub=store.watch(id,s=>b=s);
  assert.equal(calls,1);resolve(response());await flush();assert.equal(a.card.nativeRevision,1);assert.equal(a,b);ua();ub();assert.equal(store.entries.size,0);
});
test('selection switch drops late old response and evicts data',async()=>{
  const pending=[];const store=new ProgressStore(body=>new Promise(resolve=>pending.push({body,resolve})));
  let state;const off=store.watch(id,s=>state=s);off();const other={...id,nativeSessionId:'agent:fixture:b'};const off2=store.watch(other,s=>state=s);
  pending[0].resolve(response());await flush();assert.equal(state.card,null);
  pending[1].resolve(response(other,2));await flush();assert.equal(state.card.nativeRevision,2);assert.equal(store.entries.size,1);off2();
});
test('event during read fences first response then reconciles',async()=>{
  const pending=[];const store=new ProgressStore(body=>new Promise(resolve=>pending.push({body,resolve})));let state;
  const off=store.watch(id,s=>state=s);store.invalidate(id);pending[0].resolve(response());await sleep(180);
  assert.equal(state.card,null);assert.equal(pending.length,2);pending[1].resolve(response(id,2));await flush();assert.equal(state.card.nativeRevision,2);off();
});
test('reconnect epoch fences old in-flight response',async()=>{
  const pending=[];const store=new ProgressStore(()=>new Promise(resolve=>pending.push(resolve)));let state;
  const off=store.watch(id,s=>state=s);store.connectionChanged();pending[0](response());await sleep(180);assert.equal(state.card,null);pending[1]({...response(id,2),connectionEpoch:'e2'});await flush();assert.equal(state.connectionEpoch,'e2');off();
});
test('denial erases previous private card',async()=>{
  let result=response();const store=new ProgressStore(async()=>result);let state;const off=store.watch(id,s=>state=s);await flush();assert.ok(state.card);
  result={availability:'denied',card:null};store.invalidate(id);await flush();assert.equal(state.card,null);assert.equal(state.availability,'denied');off();
});
test('transient error preserves only labelled stale card',async()=>{
  let fail=false;const store=new ProgressStore(async()=>{if(fail)throw Error('private upstream error');return response();});let state;
  const off=store.watch(id,s=>state=s);await flush();fail=true;store.invalidate(id);await flush();assert.equal(state.stale,true);assert.ok(state.card);assert.equal(state.availability,'unavailable');assert.ok(!JSON.stringify(state).includes('private upstream'));off();
});
test('new connection unavailable response cannot retain old card',async()=>{
  let result=response();const store=new ProgressStore(async()=>result);let state;const off=store.watch(id,s=>state=s);await flush();result={...response(),availability:'unavailable',connectionEpoch:'e2',card:null};store.invalidate(id);await flush();assert.equal(state.card,null);off();
});
test('older revision rejected, authoritative null accepted',async()=>{
  let result=response(id,3);const store=new ProgressStore(async()=>result);let state;const off=store.watch(id,s=>state=s);await flush();
  result=response(id,2);store.invalidate(id);await flush();assert.equal(state.card.nativeRevision,3);assert.equal(state.stale,true);
  result={...response(),card:null};store.invalidate(id);await flush();assert.equal(state.card,null);assert.equal(state.stale,false);off();
});
test('wrong response identity cannot paint another session',async()=>{
  const store=new ProgressStore(async()=>response({...id,nativeSessionId:'agent:fixture:secret'}));let state;const off=store.watch(id,s=>state=s);await flush();assert.equal(state.card,null);assert.equal(state.availability,'unavailable');off();
});
test('dismiss sends only native fence and identity, never authoring',async()=>{
  const calls=[];const store=new ProgressStore(async body=>{calls.push(body);return response();});const off=store.watch(id,()=>{});await flush();await store.dismiss(id);
  assert.deepEqual(calls[1],{identity:id,action:'dismiss',expectedRevision:1,connectionEpoch:'e1'});off();
});
test('pending, notes-only, stale and unsupported dismissal blocked',async()=>{
  for(const patch of [{card:{items:[{status:'pending'}],nativeRevision:1}}, {card:{items:[],nativeRevision:1}}, {capabilities:{dismissCompleted:false}}]){
    let calls=0;const store=new ProgressStore(async()=>{calls++;return {...response(),...patch};});const off=store.watch(id,()=>{});await flush();await store.dismiss(id);assert.equal(calls,1);off();
  }
});
test('bounded active entries and cleanup',async()=>{
  const store=new ProgressStore(async body=>response(body.identity));const clean=[];
  for(let i=0;i<16;i++)clean.push(store.watch({...id,nativeSessionId:'agent:fixture:'+i},()=>{}));
  assert.throws(()=>store.watch({...id,nativeSessionId:'agent:fixture:overflow'},()=>{}));await flush();clean.forEach(f=>f());assert.equal(store.entries.size,0);
});
test('rate limit supplies bounded retry deadline',async()=>{
  const store=new ProgressStore(async()=>{const e=Error('rate');e.retryAfter=60000;throw e;});const off=store.watch(id,()=>{});await flush();const entry=[...store.entries.values()][0];assert.ok(entry.nextAt-Date.now()>59000);off();
});
test('connection replacement immediately hides prior authorized card',async()=>{
  let resolveNext;let count=0;const store=new ProgressStore(async()=>{if(++count===1)return response();return new Promise(r=>resolveNext=r);});let state;
  const off=store.watch(id,s=>state=s);await flush();assert.ok(state.card);store.connectionChanged();assert.equal(state.card,null);
  resolveNext({...response(),connectionEpoch:'e2'});await flush();assert.equal(state.connectionEpoch,'e2');off();
});
test('event flood coalesces pending reads and stale notifications',async()=>{
  const pending=[];let paints=0;const store=new ProgressStore(()=>new Promise(resolve=>pending.push(resolve)));const off=store.watch(id,()=>paints++);
  for(let i=0;i<1000;i++)store.invalidate(id);
  assert.equal(pending.length,1);assert.ok(paints<=2);pending[0](response());await sleep(180);assert.equal(pending.length,2);pending[1](response(id,2));await flush();off();
});
test('composer visibility requires native checklist or note, never a placeholder',()=>{
  const {hasProgressContent}=globalThis.VirtualWorldSessionProgress;
  for(const availability of ['unknown','supported','unsupported','denied','unavailable']){
    assert.equal(hasProgressContent({availability,card:null}),false);
    assert.equal(hasProgressContent({availability,card:{items:[],note:{content:' \u200b '}}}),false);
  }
  assert.equal(hasProgressContent({availability:'supported',card:{items:[{text:'Actual task'}]}}),true);
  assert.equal(hasProgressContent({availability:'supported',card:{note:{content:'Native note only'}}}),true);
  assert.equal(hasProgressContent({availability:'unavailable',stale:true,card:{items:[{text:'Last authorized task'}]}}),true);
  assert.equal(hasProgressContent({availability:'denied',card:{items:[{text:'Private'}]}}),false);
  assert.equal(hasProgressContent({availability:'unsupported',card:{note:{content:'Not authoritative'}}}),false);
});
