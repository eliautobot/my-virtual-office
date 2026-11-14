"""Fixture-only security regressions; run exclusively through safe-exec.sh."""
import copy
import json
import http.server
import socketserver
import threading
import unittest
import urllib.error
from unittest import mock
from test_session_progress_http import HttpProgressTests


class AuthorizationRegressions(HttpProgressTests):
    # Do not inherit/recount the parent HTTP cases; share its isolated harness.
    def test_disabled_manifest_cached_offline_owner_never_routes(self):
        manifest = mock.Mock(enabled=False, capabilities={'taskProgress': True})
        registry = mock.Mock(); registry.manifest.return_value = manifest
        before = len(self.calls)
        with mock.patch.object(self.server, '_get_provider_registry', return_value=registry), mock.patch.object(self.server, '_discovered_roster', [dict(self.server._discovered_roster[0], available=False, connectionState='offline')]):
            for action in ('read', 'dismiss'):
                data = self.request({'identity':self.identity,'action':action,'expectedRevision':1,'connectionEpoch':'fixture'} if action == 'dismiss' else {'identity':self.identity})[2]
                self.assertEqual(data['availability'], 'denied')
        self.assertEqual(len(self.calls), before); self.assertGreater(registry.manifest.call_count, 0)

    def test_current_keyed_configuration_authorizes_without_legacy_list(self):
        configured = {'agents': {'entries': {'fixture': {'name': 'Fixture'}}}}
        with mock.patch.object(self.server, '_progress_configured_owners', self.owners.temp_original), mock.patch('builtins.open', mock.mock_open(read_data=json.dumps(configured))):
            self.assertEqual(self.server._progress_configured_owners(), [{'id': 'fixture', 'name': 'Fixture'}])
            self.assertEqual(self.server._handle_session_progress({'identity': self.identity})['availability'], 'supported')

    def test_current_keyed_configuration_is_authoritative_and_fail_closed(self):
        variants = [
            ({'entries': {}, 'list': [{'id': 'fixture'}]}, []),
            ({'entries': None, 'list': [{'id': 'fixture'}]}, []),
            ({'entries': {'fixture': {'enabled': False}}}, []),
            ({'entries': {'configured': {'id': 'stale'}, 'invalid': None}}, [{'id': 'configured'}]),
            ({'list': [{'id': 'fixture'}]}, [{'id': 'fixture'}]),
        ]
        for agents, expected in variants:
            with self.subTest(agents=agents), mock.patch.object(self.server, '_progress_configured_owners', self.owners.temp_original), mock.patch('builtins.open', mock.mock_open(read_data=json.dumps({'agents': agents}))):
                self.assertEqual(self.server._progress_configured_owners(), expected)

    def test_removed_config_owner_cached_row_never_routes(self):
        before = len(self.calls)
        with mock.patch.object(self.server, '_progress_configured_owners', return_value=[]):
            self.assertEqual(self.request()[2]['availability'], 'denied')
        self.assertEqual(len(self.calls), before)

    def test_disconnected_but_configured_owner_still_authorized(self):
        row = dict(self.server._discovered_roster[0], available=False, connectionState='offline')
        with mock.patch.object(self.server, '_discovered_roster', [row]):
            self.assertEqual(self.request()[2]['availability'], 'supported')

    def test_effective_capability_revocation_never_routes(self):
        row = dict(self.server._discovered_roster[0], capabilities={'taskProgress':False})
        before = len(self.calls)
        with mock.patch.object(self.server, '_discovered_roster', [row]):
            self.assertEqual(self.request()[2]['availability'], 'denied')
        self.assertEqual(len(self.calls), before)

    def test_revocation_during_every_native_outcome_erases(self):
        for outcome in ({'ok':True,'payload':{'card':None}}, {'ok':False,'error':{'code':'unavailable'}}, None, ValueError('failure')):
            for revoke in ('owner','manifest','capability'):
                with self.subTest(outcome=repr(outcome), revoke=revoke):
                    owners = [{'id':'fixture'}]
                    row = dict(self.server._discovered_roster[0], capabilities={'taskProgress':True})
                    manifest = mock.Mock(enabled=True,capabilities={'taskProgress':True})
                    registry = mock.Mock(); registry.manifest.return_value=manifest
                    def native(*a,**kw):
                        if revoke == 'owner': owners.clear()
                        elif revoke == 'manifest': manifest.enabled=False
                        else: row['capabilities']['taskProgress']=False
                        if isinstance(outcome,Exception): raise outcome
                        return outcome
                    with mock.patch.object(self.server,'_progress_configured_owners',return_value=owners), mock.patch.object(self.server,'_discovered_roster',[row]), mock.patch.object(self.server,'_get_provider_registry',return_value=registry), mock.patch.object(self.native,'request',side_effect=native):
                        result=self.request()[2]
                        self.assertEqual(result['availability'],'denied');self.assertIsNone(result['card'])

    def test_hermes_config_revocation_during_unavailable_erases(self):
        cfg={'id':'h','apiUrl':'http://fixture.invalid','apiKey':''}
        configs=[cfg]
        row=dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)
        identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
        def fail(*args,**kwargs):
            configs.clear()
            raise OSError('fixture failure')
        client=mock.Mock();client.session_messages.side_effect=fail
        with mock.patch.object(self.server,'_hermes_connections',return_value=configs), mock.patch.object(self.server,'_discovered_roster',[row]), mock.patch.object(self.server,'_resolve_hermes_progress_endpoint',return_value={'ok':True,'endpoint':{'url':cfg['apiUrl']}}), mock.patch.object(self.server,'HermesApiClient',return_value=client):
            result=self.server._read_hermes_progress(identity)
            self.assertEqual(result['availability'],'denied');self.assertIsNone(result['card'])

    def test_hermes_current_exact_config_and_effective_override(self):
        row=dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',capabilities={'taskProgress':True,'sessionSwitch':True})
        registry=mock.Mock();registry.manifest.return_value=mock.Mock(enabled=True,capabilities={'taskProgress':False})
        with mock.patch.object(self.server,'_get_provider_registry',return_value=registry), mock.patch.object(self.server,'_discovered_roster',[row]), mock.patch.dict(self.server.VO_CONFIG,{'hermes':{'enabled':True}}), mock.patch.object(self.server,'_hermes_connections',return_value=[{'id':'h'}]) as configs:
            self.assertEqual(self.server._progress_authorized_roster(),[row])
            configs.return_value=[];self.assertEqual(self.server._progress_authorized_roster(),[])
            configs.return_value=[{'id':'other'}];self.assertEqual(self.server._progress_authorized_roster(),[])
            configs.return_value=[{'id':'h'}];row['capabilities']['sessionSwitch']=False
            self.assertEqual(self.server._progress_authorized_roster(),[])

# Only execute the new cases under this class, not inherited test methods.
for _name in list(HttpProgressTests.__dict__):
    if _name.startswith('test_') and _name not in AuthorizationRegressions.__dict__:
        setattr(AuthorizationRegressions, _name, None)


class TaskRedirectRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hits=[];cls.redirect_path='';cls.redirect_status=302
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                cls.hits.append((self.server.server_address[1],self.path,self.headers.get('Authorization')))
                if self.path.split('?')[0] == cls.redirect_path:
                    self.send_response(cls.redirect_status);self.send_header('Location',cls.target+'/captured');self.end_headers();return
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                payload={'status':'ok','features':{'session_resources':True},'endpoints':{'session_messages':True},'session_id':'s','data':[]}
                self.wfile.write(json.dumps(payload).encode())
        cls.servers=[socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler) for _ in range(2)]
        cls.threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in cls.servers]
        for t in cls.threads:t.start()
        cls.base=f'http://127.0.0.1:{cls.servers[0].server_address[1]}'
        cls.target=f'http://127.0.0.1:{cls.servers[1].server_address[1]}'
    @classmethod
    def tearDownClass(cls):
        for s in cls.servers:s.shutdown();s.server_close()
        for t in cls.threads:t.join(2)
    def test_task_transport_rejects_all_redirect_codes_on_probes_and_history(self):
        from providers.hermes import HermesApiClient
        client=HermesApiClient(base_url=self.base,api_key='synthetic-fixture',task_only=True,max_response_bytes=2097152)
        for code in (301,302,303,307,308):
            for path,call in [('/health',client.health),('/v1/capabilities',client.capabilities),('/api/sessions/s/messages',lambda:client.session_messages('s',limit=500,offset=0,order='latest'))]:
                with self.subTest(code=code,path=path):
                    type(self).redirect_path=path;type(self).redirect_status=code;self.hits.clear()
                    with self.assertRaises(urllib.error.HTTPError) as caught:call()
                    self.assertEqual(caught.exception.code,code)
                    self.assertEqual(len(self.hits),1);self.assertEqual(self.hits[0][0],self.servers[0].server_address[1])
    def test_task_resolver_and_final_history_reject_redirects_end_to_end(self):
        import tempfile
        from pathlib import Path
        from test_session_progress_http import helpers
        with tempfile.TemporaryDirectory() as directory:
            server,*_=helpers.load_server(Path(directory))
            cfg={'id':'h','apiUrl':self.base,'apiKey':'synthetic-fixture'}
            identity=dict(connectionId='h',providerKind='hermes',nativeOwnerId='h',nativeSessionId='s')
            row=dict(providerKind='hermes',providerConnectionId='h',providerAgentId='h',apiAvailable=True)
            for endpoint in ('/health','/v1/capabilities','/api/sessions/s/messages'):
                with self.subTest(endpoint=endpoint):
                    type(self).redirect_path=endpoint;type(self).redirect_status=302;self.hits.clear()
                    with mock.patch.object(server,'_hermes_connections',return_value=[cfg]), mock.patch.object(server,'_discovered_roster',[row]):
                        result=server._read_hermes_progress(identity)
                    self.assertEqual(result['availability'],'unavailable');self.assertIsNone(result['card'])
                    self.assertTrue(self.hits);self.assertTrue(all(hit[0]==self.servers[0].server_address[1] for hit in self.hits))
                    self.assertEqual(self.hits[-1][1].split('?')[0],endpoint)
            type(self).redirect_path='';self.hits.clear()
            with mock.patch.object(server,'_hermes_connections',return_value=[cfg]):
                auth=mock.Mock(side_effect=[None,PermissionError('revoked')])
                result=server._resolve_hermes_progress_endpoint(cfg,authorize=auth)
                self.assertFalse(result['ok']);self.assertEqual(len(self.hits),1)
                self.assertEqual(self.hits[0][1],'/health')

    def test_unrelated_client_retains_existing_transport(self):
        from providers.hermes import HermesApiClient
        type(self).redirect_path='/health';type(self).redirect_status=302;self.hits.clear()
        # No credential on legacy compatibility proof.
        HermesApiClient(base_url=self.base,api_key='').health()
        self.assertEqual(len(self.hits),2);self.assertEqual(self.hits[-1][0],self.servers[1].server_address[1])

del HttpProgressTests
