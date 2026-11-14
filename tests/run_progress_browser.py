"""Owned sandboxed Chromium + isolated static HTTP fixture; never shared CDP.
Run via ../safe-exec.sh with OFFICE_FIXTURE_BROWSER=1. No installs/native calls.
"""
import base64,functools,json,os,subprocess,threading,time,urllib.request
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from websockets.sync.client import connect
ROOT=Path(__file__).resolve().parents[2]; C=ROOT/'candidate'
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
http=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(C)))
thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
profile=Path(os.environ['TMPDIR'])/'browser-profile';profile.mkdir(exist_ok=True)
log=(ROOT/'logs/browser-chromium.log').open('w');proc=None;ws=None;result={}
try:
    proc=subprocess.Popen([str(ROOT/'scratch/chromium/chrome'),'--headless=new','--no-first-run','--no-default-browser-check',f'--user-data-dir={profile}','--remote-debugging-port=0','about:blank'],stdout=log,stderr=log)
    deadline=time.monotonic()+20
    while not (profile/'DevToolsActivePort').exists():
        if proc.poll() is not None:raise RuntimeError('Chromium exited; see browser-chromium.log; no sandbox bypass attempted')
        if time.monotonic()>deadline:raise TimeoutError('Chromium startup')
        time.sleep(.1)
    port=(profile/'DevToolsActivePort').read_text().splitlines()[0]
    tabs=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
    ws=connect(next(t['webSocketDebuggerUrl'] for t in tabs if t['type']=='page'),max_size=10000000)
    sequence=0;errors=[]
    def rpc(method,params=None):
        global sequence
        sequence+=1;ws.send(json.dumps({'id':sequence,'method':method,'params':params or {}}))
        while True:
            item=json.loads(ws.recv(timeout=20))
            if item.get('method')=='Runtime.exceptionThrown':errors.append(item['params'])
            if item.get('id')==sequence:
                if 'error' in item:raise RuntimeError(item['error'])
                return item.get('result',{})
    def evaluate(expression):
        out=rpc('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
        if out.get('exceptionDetails'):raise RuntimeError(out['exceptionDetails'])
        return out.get('result',{}).get('value')
    rpc('Runtime.enable');rpc('Page.enable')
    url=f'http://127.0.0.1:{http.server_port}/tests/session-progress-browser.html'
    rpc('Page.navigate',{'url':url})
    deadline=time.monotonic()+20
    while not evaluate('window.fixtureResult || null'):
        if time.monotonic()>deadline:raise TimeoutError('fixture readiness')
        time.sleep(.15)
    result['portable']=evaluate('window.fixtureResult');assert result['portable']['ok'],result['portable']
    rpc('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
    evaluate('fixture.panelA.setOpen(true)')
    result['mobile']=evaluate('({width:innerWidth,drawer:fixture.panelA.drawer.getBoundingClientRect().width,input:document.querySelector("#a textarea").getBoundingClientRect().width,below:fixture.panelA.rail.getBoundingClientRect().top>fixture.refsA.rail.getBoundingClientRect().top})')
    assert result['mobile']['drawer']<=390 and result['mobile']['input']>150 and result['mobile']['below']
    rpc('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    result['nativeEscape']=evaluate('!fixture.panelA.drawerOpen && document.activeElement === fixture.panelA.rail');assert result['nativeEscape']
    shot=rpc('Page.captureScreenshot',{'format':'png'})['data'];(ROOT/'evidence/fixture-mobile.png').write_bytes(base64.b64decode(shot))
    rpc('Emulation.setDeviceMetricsOverride',{'width':1280,'height':900,'deviceScaleFactor':1,'mobile':False})
    rpc('Page.reload');deadline=time.monotonic()+20
    time.sleep(.3)
    while not evaluate('window.fixtureResult?.ok || false'):
        if time.monotonic()>deadline:raise TimeoutError('reload fixture readiness')
        time.sleep(.15)
    result['reload']=evaluate('window.fixtureResult');assert result['reload']['ok']
    shot=rpc('Page.captureScreenshot',{'format':'png'})['data'];(ROOT/'evidence/fixture-desktop.png').write_bytes(base64.b64decode(shot))
    result['uncaughtErrors']=errors;assert not errors
    result['ok']=True
finally:
    if ws:ws.close()
    if proc:
        proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
    http.shutdown();http.server_close();thread.join(2);log.close()
    result['ownedProcessStopped']=proc is None or proc.poll() is not None
    (ROOT/'evidence/browser-results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
