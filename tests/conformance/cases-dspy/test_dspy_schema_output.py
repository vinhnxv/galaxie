# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Characterize native formats and the unchanged default before opting in."""

import asyncio
import json
from unittest.mock import patch

from galaxie import dspy as face
from galaxie import GalaxieError
import pytest

from schema_native import measure
from schema_programs import CHAT_REPLY, JSON_REPLY, Program, QUESTION, adapter_for
from test_dspy_durable import Store as DurableStore, pending
import test_dspy_durable as durable


def execute(context, before=None):
    if before is not None:
        return durable.execute(context, before)
    context['_galaxie_input'] = json.dumps({'threadId': 'session', 'steps': 10, 'input': {'question': QUESTION}})
    return json.loads(asyncio.run(context['_galaxie_execute']()))


class Store(DurableStore):
    def __init__(self, reply=JSON_REPLY):
        super().__init__()
        self.reply, self.payloads = reply, []

    async def request(self, raw):
        message = json.loads(raw)
        if message['op'] == 'model':
            self.requests += 1
            self.payloads.append(message['payload'])
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': True, 'payload': {'content': self.reply}})
        return await super().request(raw)

    def boot_schema(self, name='so-json-adapter-schema', *, lm=None, pause=False, changed=False):
        lm = lm if lm is not None else face.GalaxieLM('answer', schema_output=True)
        def factory(*_):
            return face.Executor(Program(name, lm, pause=pause, changed=changed), adapter=adapter_for(name),
                                 stream_fields=('answer',) if name == 'so-stream-schema-refused' else ())
        with patch.object(durable.durable, 'factory', factory):
            return self.boot('schema')


@pytest.mark.parametrize('name,reply', [('so-json-adapter-schema', JSON_REPLY), ('so-explicit-response-format', CHAT_REPLY), ('so-schema-tools-refused', CHAT_REPLY), ('so-json-object-refused', '{"answer":{}}')])
def test_plain_dspy_schema_format(name, reply):
    value, formats = asyncio.run(measure(name, reply))
    assert value['error'] is None
    format_, = formats
    if name == 'so-json-object-refused':
        assert format_ == {'type': 'json_object'}
    else:
        assert format_['type'] == 'json_schema'
        assert format_['strict'] is True
        assert format_['name']
        schema = format_['schema']
        assert schema['type'] == 'object'
        assert schema['additionalProperties'] is False
        assert schema['required'] == ['answer']
        assert schema['properties']['answer']['enum'] == ['done', 'other']
        assert value['requests'][0]['jsonSchema'] == schema
    print(json.dumps({'case': name, 'format': format_}, sort_keys=True))


def test_default_lm_remains_unconstrained_and_explicit_format_refused():
    lm = face.GalaxieLM('answer')
    assert lm.supported_params == {'stop'}
    assert lm.supports_response_schema is False
    assert face.GalaxieLM('answer', native_tools=True).supported_params == {'stop', 'tool_choice'}
    assert face.GalaxieLM('answer', native_tools=True).supports_response_schema is False
    store = Store()
    assert execute(store.boot_schema(lm=lm)) == {'ok': True, 'output': {'answer': 'done'}}
    assert store.payloads[0]['options'] == {}
    store = Store(CHAT_REPLY)
    assert execute(store.boot_schema('so-explicit-response-format', lm=lm)) == {'ok': False, 'code': 'unsupported'}
    assert store.requests == 0 and store.calls == []


def test_native_and_default_typed_violation_make_one_request():
    value, _ = asyncio.run(measure('so-typed-violation', '{"answer":"wrong"}'))
    assert value['error']['code'] == 'executor_error'
    assert len(value['requests']) == 1
    store = Store('{"answer":"wrong"}')
    assert execute(store.boot_schema(lm=face.GalaxieLM('answer'))) == {'ok': False, 'code': 'executor_error'}
    assert store.requests == 1


def test_local_schema_probe_reaches_forward_refusal_and_replay_gates(monkeypatch):
    class ProbeLM(face.GalaxieLM):
        @property
        def supported_params(self):
            return {'stop', 'response_format'}

        @property
        def supports_response_schema(self):
            return True

    original = face._options
    def options(value, native, *args):
        format_ = value.config.response_format
        if format_ is None:
            return original(value, native, *args)
        if format_.get('type') != 'json_schema' or not isinstance(format_.get('schema'), dict) or value.tools:
            raise GalaxieError('unsupported')
        return {'jsonSchema': face._json(format_['schema'])}

    monkeypatch.setattr(face, '_options', options)
    for name, reply in [('so-json-adapter-schema', JSON_REPLY), ('so-explicit-response-format', CHAT_REPLY)]:
        store = Store(reply)
        assert execute(store.boot_schema(name, lm=ProbeLM('answer'))) == {'ok': True, 'output': {'answer': 'done'}}
        twin, _ = asyncio.run(measure(name, reply))
        assert store.payloads[0]['options'] == {'jsonSchema': twin['requests'][0]['jsonSchema']}
    store = Store()
    assert execute(store.boot_schema('so-json-object-refused', lm=ProbeLM('answer'))) == {'ok': False, 'code': 'unsupported'}
    assert store.requests == 0
    for changed in (False, True):
        store = Store()
        context = store.boot_schema(lm=ProbeLM('answer'), pause=True)
        assert execute(context) == {'ok': True, 'interrupted': True}
        before = pending(context)
        assert before is not None
        result = execute(store.boot_schema(lm=ProbeLM('answer'), pause=True, changed=changed), before)
        assert result == ({'ok': False, 'code': 'unrecoverable'} if changed else {'ok': True, 'output': {'answer': 'done'}})
        assert store.requests == 1


@pytest.mark.parametrize('name,reply,code,count', [
    ('so-json-adapter-schema', JSON_REPLY, None, 1),
    ('so-explicit-response-format', CHAT_REPLY, None, 1),
    ('so-typed-violation', '{"answer":"wrong"}', 'executor_error', 1),
    ('so-mock-ignores-schema', 'plain prose', 'executor_error', 1),
    ('so-json-object-refused', '{"answer":{}}', 'unsupported', 0),
    ('so-schema-tools-refused', CHAT_REPLY, 'unsupported', 0),
    ('so-stream-schema-refused', CHAT_REPLY, 'unsupported', 0),
])
def test_shipped_schema_gates(name, reply, code, count):
    store = Store(reply)
    result = execute(store.boot_schema(name))
    assert result == ({'ok': False, 'code': code} if code else {'ok': True, 'output': {'answer': 'done'}})
    assert store.requests == count and store.calls == []
    if count:
        twin, _ = asyncio.run(measure(name, reply))
        assert store.payloads[0]['options'] == {'jsonSchema': twin['requests'][0]['jsonSchema']}
        assert result.get('output') == twin['output']


@pytest.mark.parametrize('changed', [False, True])
def test_shipped_schema_restore_and_changed_signature(changed):
    store = Store()
    context = store.boot_schema(pause=True)
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    result = execute(store.boot_schema(pause=True, changed=changed), before)
    assert result == ({'ok': False, 'code': 'unrecoverable'} if changed else {'ok': True, 'output': {'answer': 'done'}})
    assert store.requests == 1
