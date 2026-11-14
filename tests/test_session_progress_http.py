"""Isolated real HTTP facade with injected native transports, no provider state."""
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest import mock
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'app'))
spec = importlib.util.spec_from_file_location('progress_http_helpers',ROOT/'tests'/'test_chat_sessions.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)

class HttpProgressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='vw-progress-http-')
        cls.server,*_=helpers.load_server(Path(cls.temp.name))
        cls.server._discovered_roster=[dict(id='fixture',providerKind='openclaw',providerAgentId='fixture',providerConnectionId='default',capabilities={'taskProgress':True})]
        cls.owners=mock.patch.object(cls.server,'_progress_configured_owners',return_value=[{'id':'fixture'}]);cls.owners.start()
        cls.calls=[]
        cls.native=mock.Mock()
        cls.native.status.return_value={'generation':1}
        cls.native.request.side_effect=lambda method,params,**kwargs: cls._native_response(method,params)
        cls.patch=mock.patch.object(cls.server,'_get_openclaw_gateway_client',return_value=cls.native);cls.patch.start()
        cls.config=mock.patch.object(cls.server,'_gateway_config_key',return_value=('fixture',));cls.config.start()
        cls.http=socketserver.ThreadingTCPServer(('127.0.0.1',0),cls.server.OfficeHandler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.http.server_address[1]}'
        cls.identity=dict(connectionId='default',providerKind='openclaw',nativeOwnerId='fixture',nativeSessionId='agent:fixture:test')
    @classmethod
    def _native_response(cls,method,params):
        cls.calls.append((method,params))
        return {'ok':True,'payload':{'card':None}}
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join(2);cls.patch.stop();cls.config.stop();cls.owners.stop();cls.temp.cleanup()
    def request(self,body=None,auth=True,origin=None,path='/api/openclaw/task-progress'):
        headers={'Content-Type':'application/json','Origin':origin or self.base}
        if auth: headers['Cookie']=f'{self.server._OPENCLAW_PROXY_COOKIE_NAME}={self.server._OPENCLAW_PROXY_SECRET}'
        req=urllib.request.Request(self.base+path,data=json.dumps(body or {'identity':self.identity}).encode(),headers=headers,method='POST')
        try:
            with urllib.request.urlopen(req,timeout=5) as resp:return resp.status,dict(resp.headers),json.load(resp)
        except urllib.error.HTTPError as exc:
            with exc:return exc.code,dict(exc.headers),json.load(exc)
    def test_read_private_cache_and_no_mutation(self):
        status,headers,data=self.request()
        self.assertEqual(status,200);self.assertEqual(data['availability'],'supported');self.assertIn('no-store',headers['Cache-Control']);self.assertEqual(self.calls[-1][0],'progressCard.get')
    def test_real_cookie_jar_bootstrap_authorizes_scoped_facade(self):
        import http.cookiejar
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        with mock.patch.object(self.server, "_gateway_info_payload", return_value={"transport": "proxy"}):
            with opener.open(self.base + "/gateway-info", timeout=5) as bootstrap:
                self.assertEqual(bootstrap.status, 200)
        request = urllib.request.Request(self.base + "/api/openclaw/task-progress", data=json.dumps({"identity": self.identity}).encode(), headers={"Content-Type": "application/json", "Origin": self.base}, method="POST")
        with opener.open(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response)["availability"], "supported")

    def test_missing_cookie_denied(self):
        before=len(self.calls);status,_,data=self.request(auth=False)
        self.assertEqual(status,403);self.assertEqual(data['availability'],'denied');self.assertEqual(len(self.calls),before)
    def test_cross_origin_denied(self):
        before=len(self.calls);status,_,_=self.request(origin='https://evil.invalid')
        self.assertEqual(status,403);self.assertEqual(len(self.calls),before)
    def test_oversize_rejected(self):
        self.assertEqual(self.request({'identity':self.identity,'extra':'x'*9000})[0],413)
    def test_arbitrary_rpc_stays_blocked(self):
        for method in ['progressCard.get','progressCard.put','tools.invoke']:
            self.assertEqual(self.request({'method':method,'params':{}},path='/api/openclaw/rpc')[0],403)
    def test_facade_authoring_rejected(self):
        before=len(self.calls);data=self.request({'identity':self.identity,'action':'put','markdown':'not allowed'})[2]
        self.assertEqual(data['code'],'invalid_request');self.assertEqual(len(self.calls),before)
    def test_dismiss_requires_connection_fence(self):
        before=len(self.calls);data=self.request({'identity':self.identity,'action':'dismiss','expectedRevision':1,'connectionEpoch':'wrong'})[2]
        self.assertEqual(data['code'],'connection_changed');self.assertEqual(len(self.calls),before)
    def test_fenced_dismiss_fixture_only(self):
        epoch=self.request()[2]['connectionEpoch']
        data=self.request({'identity':self.identity,'action':'dismiss','expectedRevision':1,'connectionEpoch':epoch})[2]
        self.assertEqual(data['availability'],'supported');self.assertEqual(self.calls[-1],('progressCard.put',{'sessionKey':self.identity['nativeSessionId'],'expectedRevision':1}))
    def test_forged_owner_denied(self):
        data=self.request({'identity':dict(self.identity,nativeOwnerId='other')})[2]
        self.assertEqual(data['availability'],'denied')
    def test_hermes_read_never_autostarts_and_bounds_history(self):
        identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
        fake=mock.Mock();fake.session_messages.return_value={'session_id':'s','data':[]}
        cfg={'id':'h','apiUrl':'http://fixture.invalid','apiKey':'fixture'}
        with mock.patch.object(self.server,'_discovered_roster',[dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)]), mock.patch.object(self.server,'_resolve_hermes_progress_endpoint',return_value={'ok':True,'endpoint':{'url':'http://fixture.invalid'}}) as resolve, mock.patch.object(self.server,'_hermes_connections',return_value=[cfg]), mock.patch.object(self.server,'HermesApiClient',return_value=fake) as client:
            result=self.server._read_hermes_progress(identity)
            self.assertEqual(result['availability'],'unknown');resolve.assert_called_once_with(cfg, authorize=None)
            fake.session_messages.assert_called_once_with('s',limit=500,offset=0,order='latest')
            self.assertEqual(client.call_args.kwargs['max_response_bytes'],2097152)
    def test_hermes_lineage_rotation_not_merged(self):
        from session_progress import hermes_history_snapshot
        with self.assertRaises(ValueError):hermes_history_snapshot({'session_id':'rotated','data':[]},'original')

    def test_no_cors_on_success_or_denial(self):
        for auth in (True, False):
            status, headers, data = self.request(auth=auth)
            self.assertNotIn('Access-Control-Allow-Origin', headers)
            self.assertEqual(headers.get('Cache-Control'), 'no-store')
            self.assertEqual(headers.get('X-Content-Type-Options'), 'nosniff')

    def test_invalid_json_and_transfer_encoding_are_private(self):
        import http.client
        for body, extra, expected in [(b'{', {}, 400), (b'{}', {'Transfer-Encoding':'chunked'}, 413)]:
            conn=http.client.HTTPConnection('127.0.0.1',self.http.server_address[1],timeout=5)
            headers={'Cookie':f'{self.server._OPENCLAW_PROXY_COOKIE_NAME}={self.server._OPENCLAW_PROXY_SECRET}', 'Origin':self.base, 'Content-Length':str(len(body)), **extra}
            conn.request('POST','/api/openclaw/task-progress',body,headers)
            response=conn.getresponse();self.assertEqual(response.status,expected)
            self.assertEqual(response.getheader('Cache-Control'),'no-store');response.read();conn.close()

    def test_host_port_mismatch_denied_without_native_call(self):
        before=len(self.calls)
        self.assertEqual(self.request(origin='http://127.0.0.1:1')[0],403)
        self.assertEqual(len(self.calls),before)

    def test_read_passes_generation_and_config_fences(self):
        self.request()
        self.assertEqual(self.native.request.call_args.kwargs['expected_generation'],1)
        self.assertEqual(self.native.request.call_args.kwargs['config_key'],('fixture',))

    def test_hermes_exact_config_missing_or_duplicate_fails_closed(self):
        identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
        roster=[dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)]
        for configs in ([],[{'id':'other'}],[{'id':'h'},{'id':'h'}]):
            with mock.patch.object(self.server,'_discovered_roster',roster), mock.patch.object(self.server,'_hermes_connections',return_value=configs), mock.patch.object(self.server,'_resolve_hermes_progress_endpoint') as resolve:
                self.assertEqual(self.server._read_hermes_progress(identity)['availability'],'denied')
                resolve.assert_not_called()

    def test_hermes_config_rotation_discards_snapshot(self):
        identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
        roster=[dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)]
        cfg={'id':'h','apiUrl':'http://fixture.invalid','apiKey':'fixture'}
        fake=mock.Mock();fake.session_messages.return_value={'session_id':'s','data':[]}
        with mock.patch.object(self.server,'_discovered_roster',roster), mock.patch.object(self.server,'_hermes_connections',side_effect=lambda: [cfg] if not fake.session_messages.called else [dict(cfg,apiUrl='http://changed.invalid')]), mock.patch.object(self.server,'_resolve_hermes_progress_endpoint',return_value={'ok':True,'endpoint':{'url':'http://fixture.invalid'}}), mock.patch.object(self.server,'HermesApiClient',return_value=fake):
            self.assertEqual(self.server._read_hermes_progress(identity)['code'],'connection_changed')

    def test_hermes_resolver_has_no_process_start_or_native_mutation(self):
        import inspect
        source=inspect.getsource(self.server._resolve_hermes_progress_endpoint)
        for forbidden in ('subprocess','Popen','auto_start','start_runtime','session_create'):
            self.assertNotIn(forbidden,source)

    def test_hermes_endpoint_denial_erases_not_stale(self):
        identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
        roster=[dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)]
        for code in ('endpoint_authentication_failed','endpoint_authorization_failed'):
            with mock.patch.object(self.server,'_discovered_roster',roster), mock.patch.object(self.server,'_hermes_connections',return_value=[{'id':'h'}]), mock.patch.object(self.server,'_resolve_hermes_progress_endpoint',return_value={'ok':False,'code':code,'error':'PRIVATE'}) as resolve, mock.patch.object(self.server,'HermesApiClient') as client:
                result=self.server._read_hermes_progress(identity)
                self.assertEqual(result['availability'],'denied');self.assertIsNone(result['card']);self.assertNotIn('PRIVATE',json.dumps(result));client.assert_not_called()

    def test_roster_removed_during_read_erases_response(self):
        original=self.server._discovered_roster
        def removed(*args,**kwargs):
            self.server._discovered_roster=[]
            return {'ok':True,'payload':{'card':None}}
        try:
            with mock.patch.object(self.native,'request',side_effect=removed):
                self.assertEqual(self.request()[2]['availability'],'denied')
        finally:self.server._discovered_roster=original

if __name__=='__main__':unittest.main()
