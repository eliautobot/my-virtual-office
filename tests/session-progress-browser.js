/* Run in an isolated static browser fixture, never against a native mutation API. */
(async () => {
  const {ProgressStore,ProgressPanel,renderNote}=VirtualWorldSessionProgress;
  const checks=[];const check=(name,condition)=>{checks.push({name,ok:!!condition});if(!condition)throw Error(name);};
  const flush=()=>new Promise(r=>setTimeout(r,20));
  const a={connectionId:'fixture-oc',providerKind:'openclaw',nativeOwnerId:'demo',nativeSessionId:'agent:demo:a'};
  const b={connectionId:'fixture-h',providerKind:'hermes',nativeOwnerId:'demo',nativeSessionId:'b'};
  let rev=1, denied=false, absent=false, calls=[];
  const store=new ProgressStore(async body=>{
    calls.push(body);
    const identity=body.identity;
    if(denied&&identity.nativeSessionId===a.nativeSessionId)return {identity,availability:'denied',card:null};
    return {schemaVersion:'vw-session-progress/v1',identity,availability:'supported',connectionEpoch:'fixture',observedAt:Date.now(),
      source:identity.providerKind==='hermes'?{kind:'hermes-paired-todo-history'}:{kind:'openclaw-progress-card'},
      capabilities:{dismissCompleted:identity.providerKind==='openclaw'},
      card:absent?null:identity.providerKind==='hermes'?{items:[{nativeId:'a',text:'Parallel operation one',status:'in_progress'},{nativeId:'b',text:'Parallel operation two',status:'in_progress'},{nativeId:'c',text:'Cancelled native item',status:'cancelled'}]}:
        {nativeRevision:rev,nativeUpdatedAt:Date.now(),items:[{text:'Inspect provider contract',status:'completed'},{text:'Render safely on desktop and mobile',status:'completed'}],note:{format:'markdown',content:'<progress aria-label="Tests · 3/7" value="3" max="7" onmouseover="window.xss=1"></progress>\n\n**Native progress note**\n\n| Check | State |\n| --- | --- |\n| Isolation | passed |\n| Rendering | running |\n\n[Documentation](https://example.invalid/docs)'}}};
  });
  const originalFetch=window.fetch;
  window.fetch=(url,options)=>String(url).startsWith('/api/chat-references?')
    ? Promise.resolve({ok:true,json:async()=>({references:[]})}) : originalFetch(url,options);
  const panelA=new ProgressPanel(document.querySelector('#a'),store),panelB=new ProgressPanel(document.querySelector('#b'),store);
  const refsA=new OfficeChatReferences.ReferencesPanel(document.querySelector('#a'));
  try{
    check('initial composer placeholder hidden',panelA.el.hidden&&panelB.el.hidden);
    check('tasks rail available while drawer closed',panelA.rail.isConnected&&panelA.drawer.hidden&&panelA.drawer.inert);
    panelA.select(a);panelB.select(b);await flush();panelA.el.open=panelB.el.open=true;
    check('real content reveals composer',!panelA.el.hidden&&!panelB.el.hidden);
    const beforeOpenCalls=calls.length;
    panelA.rail.click();
    check('rail opens accessible Tasks drawer',panelA.drawerOpen&&!panelA.drawer.hidden&&!panelA.drawer.inert&&panelA.rail.getAttribute('aria-expanded')==='true'&&document.activeElement===panelA.closeButton);
    check('composer and drawer share one view',panelA.el.hidden&&panelA.body.parentNode===panelA.drawer&&document.querySelector('#a').querySelectorAll('.task-progress-body').length===1);
    check('opening drawer adds no native reads or subscriptions',calls.length===beforeOpenCalls&&store.entries.size===2);
    check('drawer belongs only to its window',!panelB.drawerOpen&&!panelB.el.hidden);
    rev++;store.invalidate(a);await flush();
    check('live update reaches open shared view',panelA.state.card.nativeRevision===rev&&panelA.body.parentNode===panelA.drawer);
    const sameList=panelA.content.querySelector('ol'),noteLink=panelA.content.querySelector('a');
    noteLink.focus();const savedScroll=panelA.body.scrollTop;store.invalidate(a);await flush();
    check('unchanged refresh preserves content DOM, focus and scroll',panelA.content.querySelector('ol')===sameList&&document.activeElement===noteLink&&panelA.body.scrollTop===savedScroll);

    panelA.drawer.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    check('Escape retracts drawer and restores focus',panelA.drawer.hidden&&panelA.drawer.inert&&!panelA.el.hidden&&document.activeElement===panelA.rail&&panelA.body.parentNode===panelA.el);
    refsA.setOpen(true);await flush();panelA.rail.click();
    check('Tasks opening closes references',!document.querySelector('#a').classList.contains('chat-references-open')&&panelA.drawerOpen);
    refsA.setOpen(true);await flush();
    check('References opening retracts Tasks',document.querySelector('#a').classList.contains('chat-references-open')&&!panelA.drawerOpen&&panelA.drawer.inert);
    refsA.setOpen(false);refsA.setOpen(true);panelA.setOpen(true);await flush();
    check('rapid drawer switch cannot steal focus into hidden references',document.activeElement===panelA.closeButton&&!document.querySelector('#a').classList.contains('chat-references-open'));
    panelA.setOpen(false);
    refsA.setOpen(false);panelA.el.open=true;
    check('two sessions isolated',!panelA.content.textContent.includes('Parallel operation')&&!panelB.content.textContent.includes('Inspect provider'));
    check('native progress bar preserved and labelled',panelA.content.querySelector('progress')?.value===3&&panelA.content.querySelector('progress').getAttribute('aria-label')==='Tests · 3/7');
    check('native progress handler stripped',!panelA.content.querySelector('progress').hasAttribute('onmouseover'));
    check('Markdown table and emphasis',!!panelA.content.querySelector('table')&&!!panelA.content.querySelector('strong'));
    check('Hermes preserves multiple active and cancelled',panelB.content.querySelectorAll('[data-state="in_progress"]').length===2&&panelB.content.querySelectorAll('[data-state="cancelled"]').length===1);
    check('Hermes no notes or dismissal',!panelB.content.querySelector('.task-progress-note')&&panelB.dismissButton.hidden);
    check('limited compatibility explicitly labelled',panelB.status.textContent.includes('latest 500')&&panelB.status.textContent.includes('No native notes'));
    panelA.runEvent({kind:'run.start',runId:'r1'});check('completed checklist while run active',panelA.status.textContent.includes('Run: running')&&panelA.summary.textContent.includes('2/2'));
    panelA.runEvent({kind:'tool.complete',runId:'r1'});check('tool finish does not change lifecycle',panelA.run.state==='running');
    panelA.runEvent({kind:'run.complete',runId:'other'});check('unowned terminal run ignored',panelA.run.state==='running');
    panelA.runEvent({kind:'run.failed',runId:'r1'});check('failure preserves completed steps',panelA.run.state==='failed'&&panelA.content.querySelectorAll('[data-state="completed"]').length===2);
    const reducer=new ChatEvents.TurnEventReducer();
    reducer.ingest({kind:'run.start',runId:'reducer-run'}).forEach(e=>panelA.runEvent(e));
    reducer.ingest({kind:'run.complete',runId:'reducer-run'}).forEach(e=>panelA.runEvent(e));
    check('actual chat reducer terminal updates lifecycle',panelA.run.state==='completed');
    panelA.runEvent({kind:'run.start',runId:'reducer-run'});check('late retired run start ignored',panelA.run.state==='completed');
    const sandbox=document.createElement('div');document.body.append(sandbox);
    const attacks=[
      '<script>window.xss=1</script><img src="https://tracking.invalid/pixel" onerror="window.xss=1">',
      '<svg><a xlink:href="javascript:window.xss=1">x</a></svg><math><mtext><img src=x onerror=window.xss=1></mtext></math>',
      '<a href="jav&#x61;script:window.xss=1" onclick="window.xss=1">bad</a>',
      '<a href="data:text/html,bad">data</a><a href="file:///etc/passwd">file</a><a href="//tracking.invalid">relative</a>',
      '<form><input autofocus onfocus=window.xss=1></form><iframe srcdoc="<script>window.xss=1</script>"></iframe>',
      '<p style="background:url(https://tracking.invalid/pixel)" id="location" class="global">test</p>',
      '<a href="https://user:password@example.invalid">credentials</a>',
      '<table><tr><td><svg><style><img src=x onerror=window.xss=1></style></svg></td></tr></table>',
    ];
    for(const [index,attack] of attacks.entries()){
      renderNote(sandbox,attack);
      check(`XSS payload ${index+1} inert`,!sandbox.querySelector('script,img,svg,math,iframe,form,input,style,[style],[onclick],[onerror],[id],[class]')&&![...sandbox.querySelectorAll('a')].some(a=>/^(javascript|data|file):|password/.test(a.getAttribute('href')||'')));
    }
    renderNote(sandbox,'<progress max="0" value="1"></progress><progress max="Infinity" value="1"></progress><progress value="NaN"></progress><progress max="10" value="11"></progress>');
    check('invalid progress values rejected',sandbox.querySelectorAll('progress').length===0);
    renderNote(sandbox,'<progress aria-label="fine" value="1" max="2"></progress>'.repeat(20));check('native bars bounded',sandbox.querySelectorAll('progress').length===8);
    renderNote(sandbox,'<b>'.repeat(1500)+'bounded'+'</b>'.repeat(1500));check('depth and DOM budget',sandbox.querySelectorAll('*').length<=25);
    await flush();check('no XSS executed',!window.xss);check('no automatic remote tracking',!performance.getEntriesByType('resource').some(e=>e.name.includes('tracking.invalid')));sandbox.remove();
    denied=true;store.invalidate(a);await flush();check('denial hides previously readable note',!panelA.content.textContent&&panelA.status.textContent.includes('Access denied')&&panelA.dismissButton.hidden&&panelA.el.hidden);denied=false;store.invalidate(a);await flush();
    absent=true;store.invalidate(a);await flush();check('authoritative clear removes note and list',!panelA.content.textContent&&panelA.el.hidden);panelA.setOpen(true);check('empty session remains inspectable in explicit drawer',panelA.el.hidden&&!panelA.drawer.hidden&&panelA.status.textContent.includes('No native progress card'));panelA.setOpen(false);absent=false;store.invalidate(a);await flush();
    const entry=[...store.entries.values()].find(e=>e.identity.nativeSessionId===a.nativeSessionId);entry.state.stale=true;store.emit(entry);check('stale dismissal hidden',panelA.dismissButton.hidden&&panelA.summary.textContent.includes('stale'));entry.state.stale=false;store.emit(entry);
    const dismissedRevision=rev;rev++;await store.dismiss(a);check('dismiss revision fence preserves concurrently newer fixture',calls.at(-1).action==='dismiss'&&calls.at(-1).expectedRevision===dismissedRevision&&panelA.state.card.nativeRevision===rev);
    const old=window.confirm;window.confirm=()=>false;const before=calls.length;panelA.dismissButton.click();window.confirm=old;check('dismiss cancel makes no request',before===calls.length);
    check('composer remains focusable',!!document.querySelector('#a textarea'));document.querySelector('#a textarea').focus();check('composer focus after render',document.activeElement===document.querySelector('#a textarea'));
    check('native details keyboard target',panelA.summary.tagName==='SUMMARY'&&panelA.el.tagName==='DETAILS');
    const active=[...store.entries.values()].find(e=>e.identity.nativeSessionId===a.nativeSessionId);
    const savedState=active.state;
    active.state={...savedState,card:{note:{content:'Notes without checklist'}}};store.emit(active);
    check('notes-only progress stays visible',!panelA.el.hidden&&panelA.content.textContent.includes('Notes without checklist'));
    active.state={...savedState,availability:'unsupported',card:null};store.emit(active);panelA.setOpen(true);
    check('unsupported capability explicit only on request',panelA.el.hidden&&panelA.status.textContent.includes('not supported'));
    active.state=savedState;store.emit(active);panelA.setOpen(false);
    const scratch=document.createElement('section');scratch.className='chat-panel';scratch.innerHTML='<div class="chat-body"></div><div class="chat-input-row"></div>';document.body.append(scratch);
    const removable=new ProgressPanel(scratch,store);removable.select(a);await flush();removable.setOpen(true);removable.destroy();
    check('destroy removes owned controls without disturbing other viewers',!scratch.querySelector('.chat-tasks-drawer,.chat-tasks-rail,.task-progress')&&store.entries.size===2);scratch.remove();

    panelA.setOpen(true);panelA.select({...a,nativeSessionId:'agent:demo:other'});
    check('open drawer clears previous session immediately on switch',panelA.drawerOpen&&!panelA.content.textContent);
    await flush();panelA.select(a);await flush();panelA.setOpen(false);
    panelA.runEvent({kind:'run.start',runId:'r2'});panelA.el.open=panelB.el.open=true;
    window.fixture={checks,store,panelA,panelB,refsA,a,b};window.fixtureResult={ok:true,count:checks.length,checks};
  }catch(error){window.fixtureResult={ok:false,count:checks.length,error:error.message,checks};}
  document.querySelector('#results').textContent=JSON.stringify(window.fixtureResult,null,2);
})();
