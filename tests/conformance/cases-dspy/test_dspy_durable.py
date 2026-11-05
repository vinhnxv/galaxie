# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native driver checks; host policy, inbox and IndexedDB checks live in JavaScript."""

import asyncio
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType

import pytest

ROOT = Path(__file__).parents[3]
DRIVER = (ROOT / 'packages/adapter-pyodide/src/dspy-driver.ts').read_text().split('`', 2)[1]
spec = importlib.util.spec_from_file_location('native_dspy_durable', Path(__file__).with_name('durable.py'))
assert spec is not None and spec.loader is not None
durable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(durable)
CASES = ['durable-module', 'durable-model-replay', 'durable-two', 'durable-large-pauses', 'durable-frontier-write', 'durable-private-input', 'durable-private-result', 'durable-oversize-completion']


class Store:
    def __init__(self):
        self.rows = {}
        self.writes = {}
        self.effects = {}
        self.calls = []
        self.events = []
        self.requests = 0
        self.crash = False
        self.fail_completion = False
        self.failed = False
        self.registered = set()

    async def request(self, raw):
        message = json.loads(raw)
        op, value = message['op'], message['payload']
        code, result = None, None
        if op == 'checkpoint':
            operation = value['op']
            if operation == 'get':
                rows = [row for row in self.rows.values() if row['sessionId'] == value['sessionId']]
                result = copy.deepcopy(max(rows, key=lambda row: row['id'])) if rows else None
                if result:
                    result['writes'] = self.writes.get(result['id'], [])
                    result['parentWrites'] = self.writes.get(result['parentId'], [])
                    checkpoint = json.loads(base64.b64decode(result['checkpoint']['bytes']))
                    self.registered.add(json.dumps(checkpoint['input']))
                    if isinstance(checkpoint['input'], dict):
                        self.registered.update(json.dumps(value) for value in checkpoint['input'].values())
                    self.registered.update(json.dumps(entry.get('result')) for entry in checkpoint['journal'])
            elif operation == 'put-writes':
                self.writes[value['id']] = [{'taskId': value['taskId'], 'taskPath': value['taskPath'], **{key: item[key] for key in ('index', 'channel', 'value')}} for item in value['writes']]
            elif operation == 'put':
                if self.fail_completion and value['parentId'] is not None and not self.failed:
                    self.failed = True
                    raise OSError('Private host storage failure.')
                self.rows[value['id']] = {key: value[key] for key in ('sessionId', 'namespace', 'id', 'parentId', 'checkpoint', 'metadata')}
            else:
                raise AssertionError('Unexpected checkpoint operation.')
        elif op == 'capability':
            if value['name'] == 'outbound@1':
                assert json.dumps(value['input']['query']) in self.registered
                code = 'denied'
            else:
                scope = value['effectScope']
                digest = hashlib.sha256(json.dumps(value['input'], sort_keys=True).encode()).hexdigest()
                previous = self.effects.get(scope)
                if previous:
                    code = 'unrecoverable' if previous['digest'] != digest else 'outcome_unknown' if previous['status'] == 'dispatched' else None
                    result = previous.get('output')
                else:
                    self.calls.append(value['input']['query'])
                    result = 'x' * 280000 if value['input']['query'].startswith('large-') else durable.PRIVATE_RESULT
                    self.effects[scope] = {'digest': digest, 'status': 'succeeded', 'output': result}
        elif op == 'model':
            self.requests += 1
            if self.crash:
                raise asyncio.CancelledError()
            result = {'content': '[[ ## answer ## ]]\ndone\n[[ ## completed ## ]]'}
        else:
            raise AssertionError('Unexpected bridge operation.')
        return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': code is None, **({'error': {'code': code}} if code else {'payload': result})})

    def notify(self, raw):
        self.events.append(json.loads(raw)['payload'][2])

    def boot(self, name, changed=False):
        transport = ModuleType('_galaxie_transport')
        setattr(transport, 'request', self.request)
        setattr(transport, 'notify', self.notify)
        sys.modules[transport.__name__] = transport
        selected = ModuleType('native_durable_selected')
        setattr(selected, 'create_agent', lambda: durable.factory(name, changed))
        sys.modules[selected.__name__] = selected
        context = {'_galaxie_module': selected.__name__, '_galaxie_entry': 'create_agent', '_galaxie_durable': True}
        exec(DRIVER, context)
        assert context['_galaxie_ready'] == {'ok': True}
        return context


def execute(context, pending=None):
    context['_galaxie_input'] = json.dumps({'threadId': 'session', 'steps': 10, **({'input': {'question': durable.PRIVATE_INPUT}} if pending is None else {'resume': {'interactionId': pending['id'], 'action': 'continue', 'payload': 'continue'}})})
    return json.loads(asyncio.run(context['_galaxie_execute']()))


def pending(context):
    context['_galaxie_thread'] = 'session'
    result = json.loads(asyncio.run(context['_galaxie_pending']()))
    assert result['ok']
    return result['interrupts'][0] if result['interrupts'] else None


@pytest.mark.parametrize('name', CASES)
def test_native_driver_restores_the_session_bound_journal(name):
    store = Store()
    context = store.boot(name)
    result = execute(context)
    assert result == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    marker = store.writes['00000000000000000001'][0]['value']['bytes']
    assert json.loads(base64.b64decode(marker)) == {'id': before['id']}
    while before:
        context = store.boot(name)
        assert pending(context) == before
        result = execute(context, before)
        before = pending(context) if result['ok'] else None
    if 'private-' in name:
        assert result == {'ok': False, 'code': 'denied'}
    else:
        assert result == {'ok': True, 'output': {'answer': 'done', 'receipt': durable.PRIVATE_RESULT}}
        state = context['_galaxie_executor']._sessions[context['_galaxie_conversations']['session']]
        assert state.journal == [] and state.value is None
        assert pending(store.boot(name)) is None
    assert store.calls == (['after'] if name == 'durable-frontier-write' else ['before', 'large-0', 'large-1', 'large-2'] if name == 'durable-oversize-completion' else ['before'])
    assert store.requests == (2 if name == 'durable-model-replay' else 1)
    if 'private-' not in name:
        checkpoint = json.loads(base64.b64decode(list(store.rows.values())[-1]['checkpoint']['bytes']))
        assert (checkpoint['input'], checkpoint['journal'], checkpoint['ordinal']) == (None, [], 1)


@pytest.mark.parametrize('fault', ['receipt', 'changed', 'unfinished'])
def test_native_driver_recovers_frontier_writes_without_repeating_them(fault):
    store = Store()
    context = store.boot('durable-frontier-write')
    execute(context)
    before = pending(context)
    store.crash = True
    assert execute(store.boot('durable-frontier-write'), before) == {'ok': False, 'code': 'cancelled'}
    store.crash = False
    if fault == 'unfinished':
        for record in store.effects.values():
            record['status'] = 'dispatched'
            record.pop('output')
    result = execute(store.boot('durable-frontier-write', changed=fault == 'changed'), before)
    assert store.calls == ['after']
    if fault == 'receipt':
        assert result['ok'] and result['output']['answer'] == 'done'
    else:
        assert result == {'ok': False, 'code': 'unrecoverable' if fault == 'changed' else 'outcome_unknown'}


@pytest.mark.parametrize('fault', ['orphan', 'completion'])
def test_native_driver_checkpoint_is_the_commit_marker(fault):
    store = Store()
    context = store.boot('durable-module')
    execute(context)
    before = pending(context)
    if fault == 'orphan':
        store.writes['00000000000000000002'] = [{'taskId': 'conversation', 'taskPath': '', 'channel': '__interrupt__', 'index': -3, 'value': {'type': 'json', 'bytes': base64.b64encode(b'{"id":"orphan"}').decode()}}]
    else:
        store.fail_completion = True
    result = execute(store.boot('durable-module'), before)
    if fault == 'completion':
        assert result == {'ok': False, 'code': 'unavailable'}
        result = execute(store.boot('durable-module'), before)
    assert result['ok'] and result['output']['answer'] == 'done'
    assert store.calls == ['before']
    assert base64.b64decode(store.writes['00000000000000000002'][0]['value']['bytes']) == b'null'


@pytest.mark.parametrize('name', ['durable-url-input', 'durable-url-result'])
def test_native_pending_read_supplies_private_values_before_host_url_validation(name):
    store = Store()
    context = store.boot(name)
    assert execute(context) == {'ok': True, 'interrupted': True}
    store.registered.clear()
    restored = pending(store.boot(name))
    assert restored is not None
    secret = durable.PRIVATE_INPUT if name.endswith('input') else durable.PRIVATE_RESULT
    assert restored['value']['props']['href'] == 'https://allowed.example/?value=' + secret
    assert json.dumps(secret) in store.registered
    assert store.requests == 0 and store.calls == ['before']
