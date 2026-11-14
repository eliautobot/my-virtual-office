// DOM-emulated integration, NOT browser layout/visual proof. No native transports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const path = require('node:path');
const app = path.join(__dirname,'../app');
const source = fs.readFileSync(path.join(app,'chat.js'),'utf8');
function fixture() {
  const {document,window:dom} = parseHTML(fs.readFileSync(path.join(app,'index.html'),'utf8'));
  let active=null;
  Object.defineProperty(document,'activeElement',{get:()=>active});
  dom.HTMLElement.prototype.focus=function(){active=this;};
  Object.defineProperty(dom.HTMLSelectElement.prototype,'selectedOptions',{configurable:true,get(){return [...this.querySelectorAll('option')].filter(o=>o.hasAttribute('selected'));}});
  const window={addEventListener(){},matchMedia:()=>({matches:false}),location:{origin:'http://fixture.invalid'}};
  let requests=[];const intervals=[];
  const context=vm.createContext({document,window,globalThis:null,console,URL,URLSearchParams,AbortController,TextDecoder,
    CustomEvent:dom.CustomEvent,ChatEvents:require('../app/chat-events.js'),
    localStorage:{getItem(){return null;},setItem(){}},
    setTimeout,clearTimeout,setInterval:f=>{intervals.push(f);return intervals.length;},clearInterval(){},
    getComputedStyle:()=>({fontSize:'14px'}),requestAnimationFrame:f=>f(),cancelAnimationFrame(){},
    fetch:async (_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({schemaVersion:'vw-session-progress/v1',identity:requests.at(-1).identity,availability:'supported',connectionEpoch:'fixture',card:null})};}
  });context.globalThis=context;
  vm.runInContext(fs.readFileSync(path.join(app,'session-progress.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(app,'office-chat-references.js'),'utf8'),context);
  // Execute exact real constructor/methods, excluding app bootstrap/native transport startup.
  const begin=source.indexOf('  class ChatWindow {');
  const end=source.indexOf('\n  function ',begin);
  assert(end>begin);
  vm.runInContext(source.slice(0,end)+'\n globalThis.OfficeChatWindow=ChatWindow;globalThis.officeProgressStore=progressStore;})();',context);
  const root=document.querySelector('#chat-panel');root.classList.add('open');
  const w=new context.OfficeChatWindow(root,{isPrimary:true});
  w.refreshSessionsList=()=>{};
  const choose=(kind='openclaw',owner='fixture',connection='default',session='agent:fixture:selected')=>{
    w.agentSelect.replaceChildren();const o=document.createElement('option');o.value='selected';o.setAttribute('selected','');
    Object.assign(o.dataset,{providerKind:kind,providerAgentId:owner,providerConnectionId:connection,sessionKey:kind==='openclaw'?`agent:${owner}:main`:`${kind}:${owner}`});
    w.agentSelect.append(o);w.selectedAgentKey='selected';w.sessionKey=session;w.syncTaskProgress();return o;
  };
  return {context,document,dom,w,root,choose,requests,cleanup(){w.progressPanel.destroy();w.taskReferences.destroy();}};
}
test('Office constructor creates single view and shared References/Tasks rail',()=>{
 const f=fixture();assert.equal(f.root.querySelectorAll('.task-progress-body').length,1);assert.equal(f.root.querySelectorAll('.chat-references-rail').length,1);
 assert(f.w.progressPanel.el.hidden);assert(f.w.sessionsPanel.inert);f.cleanup();
});
test('secondary cloning does not duplicate either rail or shared progress view',()=>{
 const f=fixture();const clone=f.root.cloneNode(true);f.document.body.append(clone);const w2=new f.context.OfficeChatWindow(clone,{slot:1});
 assert.equal(clone.querySelectorAll('.chat-references-rail').length,1);assert.equal(clone.querySelectorAll('.chat-tasks-rail').length,1);assert.equal(clone.querySelectorAll('.task-progress-body').length,1);
 assert.notEqual(w2.progressPanel.drawer.id,f.w.progressPanel.drawer.id);assert.notEqual(w2.sessionsPanel.id,f.w.sessionsPanel.id);w2.progressPanel.destroy();f.cleanup();
});
test('exact non-main OpenClaw child session survives identity selection',()=>{
 const f=fixture();f.choose();assert.equal(f.w.progressPanel.identity.nativeSessionId,'agent:fixture:selected');assert.equal(f.w.progressPanel.identity.connectionId,'default');f.cleanup();
});
test('cross-owner session cannot watch through selected agent',()=>{
 const f=fixture();f.choose('openclaw','fixture','default','agent:another:selected');assert.equal(f.context.officeProgressStore.entries.size,0);f.cleanup();
});
test('missing exact connection has no owner-alias fallback',()=>{
 const f=fixture();f.choose('openclaw','fixture','','agent:fixture:selected');assert.equal(f.context.officeProgressStore.entries.size,0);f.cleanup();
});
test('Hermes native session preserves colons; lazy new session never watches',()=>{
 const f=fixture();f.choose('hermes','h','h','hermes:h:session:part');assert.equal(f.w.progressPanel.identity.nativeSessionId,'session:part');
 f.choose('hermes','h','h','hermes:h:@new:fixture');assert.equal(f.context.officeProgressStore.entries.size,0);f.cleanup();
});
test('hidden page and closed windows synchronously release owned subscription',()=>{
 const f=fixture();f.choose();assert.equal(f.context.officeProgressStore.entries.size,1);f.document.hidden=true;f.w.syncTaskProgress();assert.equal(f.context.officeProgressStore.entries.size,0);
 f.document.hidden=false;f.w.syncTaskProgress();f.root.classList.remove('open');f.w.syncTaskProgress();assert.equal(f.context.officeProgressStore.entries.size,0);f.cleanup();
});
test('history and tasks mutually exclude per window with same view and no extra read',()=>{
 const f=fixture();f.choose();const n=f.requests.length;f.w.toggleSessionsPanel(true);f.w.progressPanel.setOpen(true);assert(!f.w.sessionsPanelOpen);assert(f.w.sessionsPanel.inert);assert.equal(f.w.progressPanel.body.parentNode,f.w.progressPanel.drawer);assert.equal(f.requests.length,n);
 f.w.toggleSessionsPanel(true);assert(!f.w.progressPanel.drawerOpen);assert(f.w.progressPanel.drawer.inert);assert.equal(f.w.progressPanel.body.parentNode,f.w.progressPanel.el);f.cleanup();
});
test('Tasks Escape restores rail focus without closing chat (DOM event emulation)',()=>{
 const f=fixture();f.w.progressPanel.setOpen(true);const e=new f.dom.Event('keydown',{bubbles:true,cancelable:true});e.key='Escape';f.w.progressPanel.drawer.dispatchEvent(e);
 assert(!f.w.progressPanel.drawerOpen);assert.equal(f.document.activeElement,f.w.progressPanel.rail);assert(f.root.classList.contains('open'));f.cleanup();
});
test('actual Office turn reducer updates independent run state without changing native checklist',()=>{
 const f=fixture();f.choose();f.w.applyTurnAction=()=>{};
 f.w.applyTurnEvent({kind:'run.start',runId:'one'});assert.equal(f.w.progressPanel.run.state,'running');
 f.w.applyTurnEvent({kind:'run.complete',runId:'one'});assert.equal(f.w.progressPanel.run.state,'completed');assert.equal(f.w.progressPanel.state.card,null);f.cleanup();
});
test('selection changes erase previous DOM immediately and replace exact watcher',()=>{
 const f=fixture();f.choose();f.w.progressPanel.state={availability:'supported',card:{items:[{text:'old private content',status:'pending'}]}};f.w.progressPanel.render();f.w.setSelectedSessionKey('agent:fixture:next');assert.equal(f.w.progressPanel.content.textContent,'');assert.equal(f.context.officeProgressStore.entries.size,1);assert.equal(f.w.progressPanel.identity.nativeSessionId,'agent:fixture:next');f.cleanup();
});
test('asset order and mobile containment include Tasks without changing legacy app assets',()=>{
 const html=fs.readFileSync(path.join(app,'index.html'),'utf8');assert(html.indexOf('session-progress.js?v=')<html.indexOf('chat.js?v='));assert(source.includes('.chat-input, .task-progress-body'));
 const css=fs.readFileSync(path.join(app,'session-progress.css'),'utf8');assert(css.includes('var(--chat-tools-rail-height'));assert(css.includes('prefers-reduced-motion'));assert(css.includes('overscroll-behavior: contain'));assert(!source.includes('VirtualWorldChatReferences'));
});
for (const [name,attack] of Object.entries({
 script:'<script>window.attack=1</script><img src="https://tracking.invalid/pixel" onerror="attack()">',
 namespaces:'<svg><a xlink:href="javascript:attack()">x</a></svg><math><mtext>foreign</mtext></math>',
 encodedLink:'<a href="jav&#x61;script:attack()" onclick="attack()">bad</a>',
 schemes:'<a href="data:text/html,bad">data</a><a href="file:///etc/passwd">file</a><a href="//tracking.invalid">relative</a>',
 activeElements:'<form><input autofocus onfocus="attack()"></form><iframe srcdoc="attack"></iframe>',
 styles:'<p style="background:url(https://tracking.invalid/pixel)" id="location" class="global">text</p>',
 credentialLink:'<a href="https://user:password@example.invalid">credentials</a>',
 malformed:'<table><tr><td><svg><style><img src=x onerror=attack()></style></svg></td></tr></table>'
})) test(`structural sanitizer rejects ${name} in DOM emulation`,()=>{
 const f=fixture();f.context.marked=require('../app/marked.min.js');const target=f.document.createElement('div');
 f.context.VirtualWorldSessionProgress.renderNote(target,attack);
 assert(!target.querySelector('script,img,svg,math,iframe,form,input,style,[style],[onclick],[onerror],[id],[class]'));
 for (const a of target.querySelectorAll('a')) assert(!/^(javascript|data|file):|password/.test(a.getAttribute('href')||''));f.cleanup();
});
test('structural sanitizer bounds native progress bars, deep trees, and source size',()=>{
 const f=fixture();f.context.marked=require('../app/marked.min.js');const target=f.document.createElement('div');const render=x=>f.context.VirtualWorldSessionProgress.renderNote(target,x);
 render('<progress max="0" value="1"></progress><progress max="Infinity"></progress><progress value="NaN"></progress><progress max="1" value="2"></progress>');assert.equal(target.querySelectorAll('progress').length,0);
 render('<progress aria-label="step" value="1" max="2"></progress>'.repeat(20));assert.equal(target.querySelectorAll('progress').length,8);
 render('<b>'.repeat(1500)+'bounded'+'</b>'.repeat(1500));assert(target.querySelectorAll('*').length<=25);render('a'.repeat(100000));assert.equal(target.textContent.trim().length,8192);assert(target.textContent.length<=32768);f.cleanup();
});
test('opening Tasks in one Office window does not close another window history',()=>{
 const f=fixture();const clone=f.root.cloneNode(true);f.document.body.append(clone);const w2=new f.context.OfficeChatWindow(clone,{slot:2});w2.refreshSessionsList=()=>{};
 w2.toggleSessionsPanel(true);f.w.progressPanel.setOpen(true);assert(w2.sessionsPanelOpen);assert(!w2.progressPanel.drawerOpen);w2.progressPanel.destroy();f.cleanup();
});

test('actual Office References and Tasks share a rail without replacing header history',()=>{
 const f=fixture();assert.equal(f.w.historyRail,f.w.sessionsToggleBtn);assert.equal(f.root.querySelectorAll('.chat-history-rail').length,0);assert.equal(f.root.querySelectorAll('.chat-references-rail').length,1);assert.equal(f.root.querySelectorAll('.chat-tasks-rail').length,1);f.cleanup();
});
test('References display only safe loaded links and never request or persist native tasks',()=>{
 const f=fixture();const links=[['https://example.invalid/reference','Reference'],['javascript:bad()','bad'],['https://user:secret@example.invalid/private','private']];
 for(const [href,text] of links){const a=f.document.createElement('a');a.setAttribute('href',href);a.textContent=text;f.w.messages.append(a);}
 const n=f.requests.length;f.w.taskReferences.setOpen(true);assert.equal(f.w.taskReferences.content.querySelectorAll('a').length,1);assert.equal(f.requests.length,n);assert(f.w.taskReferences.content.textContent.includes('read-only'));f.cleanup();
});
test('References, Tasks and existing history are mutually exclusive within their own window',()=>{
 const f=fixture();f.choose();const n=f.requests.length;f.w.taskReferences.setOpen(true);f.w.progressPanel.setOpen(true);assert(!f.w.taskReferences.open);f.w.taskReferences.setOpen(true);assert(!f.w.progressPanel.drawerOpen);f.w.toggleSessionsPanel(true);assert(!f.w.taskReferences.open);assert.equal(f.requests.length,n);f.cleanup();
});
test('changing exact session clears old Reference content and retains one shared progress view',()=>{
 const f=fixture();f.choose();f.w.taskReferences.setOpen(true);assert(f.w.taskReferences.open);f.w.setSelectedSessionKey('agent:fixture:replacement');assert(!f.w.taskReferences.open);assert.equal(f.w.taskReferences.content.textContent,'');assert.equal(f.root.querySelectorAll('.task-progress-body').length,1);f.cleanup();
});

function selectionRaceFixture() {
 const f=fixture();f.context.escHtml=x=>String(x);f.choose('hermes','h','h','hermes:h:old');
 const pending=[];
 f.context.fetch=(url,opts)=>new Promise(resolve=>pending.push({url,opts,resolve}));
 f.w.fetchSessionInfo=()=>{};
 f.w.providerHistoryItems=x=>x;
 f.w.renderHistoryItems=x=>{f.rendered=x;};
 f.w.isVisibleForPolling=()=>true;
 const respond=(i,data)=>pending[i].resolve({ok:true,json:async()=>data});
 return Object.assign(f,{pending,respond});
}
test('provider switch intent synchronously erases and unwatches; out-of-order results cannot repaint',async()=>{
 const f=selectionRaceFixture();
 const first=f.w.switchToSession({id:'first'});
 assert.equal(f.w.progressPanel.identity,null);assert.equal(f.context.officeProgressStore.entries.size,0);
 f.w.syncTaskProgress();assert.equal(f.w.progressPanel.identity,null);
 const second=f.w.switchToSession({id:'second'});
 f.respond(1,{ok:true,sessionKey:'hermes:h:second',messages:[{text:'second'}]});await second;
 f.respond(0,{ok:true,sessionKey:'hermes:h:first',messages:[{text:'first'}]});await first;
 assert.equal(f.w.selectedProviderSessionId(),'second');assert.equal(f.w.activeSessionIdForPanel(),'second');
 assert.equal(f.w.progressPanel.identity.nativeSessionId,'second');assert.equal(f.rendered[0].text,'second');f.cleanup();
});
for(const dimension of ['providerAgentId','providerConnectionId']) test(`late switch cannot cross changed ${dimension}`,async()=>{
 const f=selectionRaceFixture();const request=f.w.switchToSession({id:'late'});
 f.w.agentSelect.selectedOptions[0].dataset[dimension]='replacement';
 f.respond(0,{ok:true,sessionKey:'hermes:h:late',messages:[{text:'obsolete'}]});await request;
 assert.equal(f.w.sessionKey,'hermes:h:old');assert.equal(f.rendered,undefined);assert.equal(f.w.progressPanel.identity,null);f.cleanup();
});
test('history begun before switch cannot repaint transcript or task identity after switch',async()=>{
 const f=selectionRaceFixture();f.w.startHermesApprovalPolling=()=>{};f.w.pollHermesApproval=async()=>{};
 const history=f.w.loadHistory();assert.equal(f.pending.length,1);
 const selection=f.w.switchToSession({id:'new'});
 f.respond(1,{ok:true,sessionKey:'hermes:h:new',messages:[{text:'new'}]});await selection;
 f.respond(0,{ok:true,sessionKey:'hermes:h:old',requestedSessionId:'old',messages:[{text:'old'}]});await history;
 assert.equal(f.w.sessionKey,'hermes:h:new');assert.equal(f.rendered[0].text,'new');assert.equal(f.w.progressPanel.identity.nativeSessionId,'new');f.cleanup();
});
test('session-list response begun before switch intent is ignored',async()=>{
 const f=selectionRaceFixture();f.w.refreshSessionsList=f.context.OfficeChatWindow.prototype.refreshSessionsList;
 const list=f.w.refreshSessionsList();const selection=f.w.switchToSession({id:'new'});
 f.respond(0,{ok:true,sessions:[{id:'obsolete',active:true}]});await list;
 assert.equal(f.w.currentSessions.length,0);
 // Avoid unrelated follow-up request after successful switch.
 f.w.refreshSessionsList=()=>{};
 f.respond(1,{ok:true,sessionKey:'hermes:h:new',messages:[]});await selection;
 assert.equal(f.w.activeSessionIdForPanel(),f.w.progressPanel.identity.nativeSessionId);f.cleanup();
});
test('send during pending selection does not send to the previous task/transcript session',async()=>{
 const f=selectionRaceFixture();const selection=f.w.switchToSession({id:'new'});
 f.w.input.value='must wait';await f.w.sendMessage();assert.equal(f.pending.length,1);assert.equal(f.w.input.value,'must wait');
 f.respond(0,{ok:true,sessionKey:'hermes:h:new',messages:[]});await selection;f.cleanup();
});
test('out-of-order create response cannot replace newer switch',async()=>{
 const f=selectionRaceFixture();const create=f.w.createSessionFromPanel({skipConfirm:true});const selection=f.w.switchToSession({id:'new'});
 f.respond(1,{ok:true,sessionKey:'hermes:h:new',messages:[{text:'new'}]});await selection;
 f.respond(0,{ok:true,sessionKey:'hermes:h:created'});await create;
 assert.equal(f.w.sessionKey,'hermes:h:new');assert.equal(f.w.progressPanel.identity.nativeSessionId,'new');f.cleanup();
});
