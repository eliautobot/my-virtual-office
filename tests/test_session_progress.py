"""Pure native-contract/authorization fixtures. No production native service calls."""
import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from session_progress import ProgressService, normalize_openclaw, hermes_history_snapshot

ID = dict(connectionId='default', providerKind='openclaw', nativeOwnerId='demo', nativeSessionId='agent:demo:test')
ROSTER = [dict(id='demo', providerKind='openclaw', providerAgentId='demo', providerConnectionId='default')]

def card(steps=None, **extra):
    return dict(sessionKey=ID['nativeSessionId'], revision=1, updatedAt=1788730000000,
                steps=steps if steps is not None else [dict(step='Inspect', status='pending')], **extra)

def history(todos, call='todo', session='h1'):
    return {'session_id': session, 'data': [
        {'id': 1, 'session_id': session, 'role': 'assistant', 'tool_calls': [{'id': 'c1', 'function': {'name': call, 'arguments': '{"secret":"never copy"}'}}], 'reasoning': 'never copy'},
        {'id': 2, 'session_id': session, 'role': 'tool', 'tool_call_id': 'c1', 'tool_name': call, 'content': json.dumps({'todos': todos, 'private': 'never copy'})},
    ]}

class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.current = card()
        self.epoch = 'e1'
        def gateway(method, params):
            self.calls.append((method, params))
            if method == 'progressCard.put':
                if self.current and self.current['revision'] == params['expectedRevision'] and self.current.get('steps') and all(s['status'] == 'completed' for s in self.current['steps']):
                    self.current = None
            return {'ok': True, 'payload': {'card': self.current}}
        self.service = ProgressService(roster=lambda: ROSTER, gateway=gateway, connection_epoch=lambda: self.epoch)
    def read(self, **extra):
        return self.service.handle(dict(identity=ID, **extra))
    def test_read_native_projection(self):
        self.current['reasoning'] = 'private'
        result = self.read()
        self.assertEqual(result['card']['items'][0]['status'], 'pending')
        self.assertNotIn('private', json.dumps(result))
        self.assertFalse(result['capabilities']['write'])
    def test_authoritative_clear(self):
        self.current = None
        self.assertIsNone(self.read()['card'])
        self.assertEqual(self.read()['availability'], 'supported')
    def test_markdown_only(self):
        self.current = card([], markdown='note')
        self.assertEqual(self.read()['card']['note']['content'], 'note')
    def test_byte_limits(self):
        for steps, note, valid in [(50, 'x'*8192, True), (51, '', False), (1, 'x'*8193, False), (1, '😀'*2048, True), (1, '😀'*2049, False)]:
            self.current = card([dict(step='x', status='pending')]*steps, markdown=note)
            self.assertEqual(self.read()['availability'] == 'supported', valid)
    def test_step_limits(self):
        for label, valid in [('x'*512, True), ('x'*513, False), ('😀'*128, True), ('😀'*129, False), ('\u200b', False)]:
            self.current = card([dict(step=label, status='pending')])
            self.assertEqual(self.read()['availability'] == 'supported', valid)
    def test_active_and_unknown_status_fail_closed(self):
        for steps in [[dict(step='a', status='in_progress')]*2, [dict(step='a', status='cancelled')], [dict(step='a', status='future')]]:
            self.current = card(steps)
            self.assertEqual(self.read()['availability'], 'unavailable')
    def test_dismiss_matching_completed_only(self):
        self.current = card([dict(step='a', status='completed')])
        self.assertIsNone(self.read(action='dismiss', expectedRevision=1, connectionEpoch='e1')['card'])
        self.assertEqual(self.calls[-1], ('progressCard.put', {'sessionKey': ID['nativeSessionId'], 'expectedRevision': 1}))
    def test_dismiss_obsolete_revision_preserves_new_card(self):
        self.current = card([dict(step='a', status='completed')]); self.current['revision'] = 2
        self.assertEqual(self.read(action='dismiss', expectedRevision=1, connectionEpoch='e1')['card']['nativeRevision'], 2)
    def test_dismiss_pending_or_notes_only_preserves(self):
        for native in [card(), card([], markdown='notes')]:
            self.current = native
            self.assertIsNotNone(self.read(action='dismiss', expectedRevision=1, connectionEpoch='e1')['card'])
    def test_no_general_authoring(self):
        for body in [dict(action='put'), dict(action='dismiss', plan=[]), dict(action='read', markdown='x'), dict(action='dismiss', expectedRevision=True, connectionEpoch='e1')]:
            self.read(**body)
        self.assertEqual(self.calls, [])
    def test_fenced_connection_dismiss(self):
        self.assertEqual(self.read(action='dismiss', expectedRevision=1, connectionEpoch='old')['code'], 'connection_changed')
        self.assertEqual(self.calls, [])
    def test_server_epoch_race_hides_response(self):
        def request(*_):
            self.epoch = 'e2'
            return {'ok': True, 'payload': {'card': self.current}}
        self.service.gateway = request
        self.assertEqual(self.read()['code'], 'connection_changed')
    def test_exact_owner_connection_provider(self):
        for key, value in [('nativeOwnerId','other'), ('connectionId','other'), ('providerKind','codex'), ('nativeSessionId','agent:other:test')]:
            identity = dict(ID, **{key:value})
            self.assertEqual(self.service.handle({'identity':identity})['availability'], 'denied')
        self.assertEqual(self.calls, [])
    def test_duplicate_roster_ambiguous_denied(self):
        self.service.roster = lambda: ROSTER*2
        self.assertEqual(self.read()['availability'], 'denied')
    def test_exact_session_response(self):
        self.current['sessionKey'] = 'agent:demo:other'
        self.assertEqual(self.read()['code'], 'session_mismatch')
    def test_new_never_falls_back(self):
        result = self.service.handle({'identity':dict(ID,nativeSessionId='@new:abc')})
        self.assertEqual(result['code'], 'no_native_session'); self.assertFalse(self.calls)
    def test_errors_are_safe_and_distinct(self):
        for code, expected in [('FORBIDDEN','denied'), ('method_not_found','unsupported'), ('UNAVAILABLE','unavailable')]:
            self.service.gateway = lambda *_: {'ok':False,'error':{'code':code,'message':'SECRET upstream path'}}
            result = self.read()
            self.assertEqual(result['availability'],expected); self.assertNotIn('SECRET',json.dumps(result))
    def test_unknown_provider_extension_unsupported(self):
        for kind in ['codex','claude-code','opencode','extension']:
            self.service.roster = lambda: [dict(id='demo',providerKind=kind,providerConnectionId='default')]
            result=self.service.handle({'identity':dict(ID,providerKind=kind,nativeSessionId='s1')})
            self.assertEqual(result['availability'],'unsupported'); self.assertFalse(result['capabilities']['readSnapshot'])
    def test_native_lifecycle_not_inferred(self):
        self.current=card([dict(step='a',status='completed')])
        self.assertEqual(self.read()['run']['state'],'unknown')
    def test_bad_revision_timestamp(self):
        for key, value in [('revision',True),('revision',-1),('updatedAt',float('nan')),('updatedAt','secret')]:
            self.current=card();self.current[key]=value
            self.assertEqual(self.read()['availability'],'unavailable')
    def test_hermes_cancelled_multiple_active_and_no_notes(self):
        todos=[dict(id=str(i),content='Task',status=status,notes='never copy') for i,status in enumerate(['in_progress','in_progress','cancelled','completed'])]
        result=hermes_history_snapshot(history(todos),'h1')
        self.assertEqual([i['status'] for i in result['card']['items']],[t['status'] for t in todos])
        self.assertNotIn('never copy',json.dumps(result));self.assertNotIn('note',result['card']);self.assertNotIn('nativeRevision',result['card'])
    def test_hermes_empty_clear(self):
        self.assertIsNone(hermes_history_snapshot(history([]),'h1')['card'])
    def test_hermes_wrong_call_and_prose_not_scraped(self):
        for page in [history([],call='read'), {'session_id':'h1','data':[{'id':1,'session_id':'h1','role':'assistant','content':'{"todos":[]}'}]}]:
            self.assertEqual(hermes_history_snapshot(page,'h1')['availability'],'unknown')
    def test_hermes_pair_boundary_unknown(self):
        page=history([]);page['data'].insert(1,{'id':2,'session_id':'h1','role':'user'});page['data'][-1]['id']=3
        self.assertEqual(hermes_history_snapshot(page,'h1')['availability'],'unknown')
    def test_hermes_lineage_no_alias(self):
        with self.assertRaises(ValueError): hermes_history_snapshot(history([]),'other')
    def test_hermes_limits_duplicates_and_row_order(self):
        for todos in [[dict(id=str(i),content='a',status='pending') for i in range(257)], [dict(id='a',content='a',status='pending')]*2, [dict(id='a',content='a'*4001,status='pending')]]:
            with self.assertRaises(ValueError): hermes_history_snapshot(history(todos),'h1')
        page=history([]);page['data'].reverse()
        with self.assertRaises(ValueError): hermes_history_snapshot(page,'h1')
    def test_hermes_full_result_not_merge_arguments(self):
        page=history([dict(id='a',content='Complete full result',status='completed')]);page['data'][0]['tool_calls'][0]['function']['arguments']='{"merge":true,"todos":[]}'
        self.assertEqual(len(hermes_history_snapshot(page,'h1')['card']['items']),1)
    def test_hermes_newest_clear_wins(self):
        page=history([dict(id='a',content='old',status='pending')]);tail=history([])['data']
        for row in tail: row['id']+=2
        page['data']+=tail
        self.assertIsNone(hermes_history_snapshot(page,'h1')['card'])

if __name__ == '__main__': unittest.main()
