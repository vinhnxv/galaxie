# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Pin schema-only forwarding and zero-dispatch refusal at the LM boundary."""

import asyncio
from dataclasses import fields
import json

import dspy
from dspy.lm15 import Config, FunctionTool, Message, Request
from galaxie import GalaxieError, _bridge
from galaxie.dspy import GalaxieLM, _AsyncEngine
import pytest

SCHEMA = {'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer']}
FORMAT = {'type': 'json_schema', 'schema': SCHEMA, 'name': 'AUTHOR_SECRET', 'strict': True}


def request(format_=FORMAT, *, tools=(), **config):
    value = Request(model='answer', messages=(Message.user('question'),), tools=tools, config=Config())
    # lm15 validates Config at construction. Inject malformed values only to
    # exercise the engine's defensive boundary with no dependency validation.
    for key, item in {'response_format': format_, **config}.items():
        object.__setattr__(value.config, key, item)
    return value


def transport(monkeypatch):
    seen = []
    async def send(raw):
        message = json.loads(raw)
        seen.append(message)
        return json.dumps({**{key: message[key] for key in ('v', 'op', 'id')}, 'kind': 'response', 'ok': True, 'payload': {'content': 'done'}})
    monkeypatch.setattr(_bridge, '_transport', send)
    # install_transport also handles bridge implementations that cache the callable.
    _bridge.install_transport(send)
    return seen


def test_schema_opt_in_advertises_and_sends_only_a_json_copy(monkeypatch):
    seen = transport(monkeypatch)
    lm = GalaxieLM('answer', schema_output=True)
    assert lm.supported_params == {'stop', 'response_format'}
    assert lm.supports_response_schema is True
    assert GalaxieLM('answer', native_tools=True, schema_output=True).supported_params == {'stop', 'tool_choice', 'response_format'}
    asyncio.run(lm.acall(request(stop=('end',))))
    assert seen[0]['payload']['options'] == {'jsonSchema': SCHEMA, 'stop': ['end']}
    assert 'AUTHOR_SECRET' not in json.dumps(seen)


@pytest.mark.parametrize('value', ['yes', 1, None])
def test_invalid_schema_opt_in_is_fixed_invalid(value):
    with pytest.raises(GalaxieError) as error:
        GalaxieLM('answer', schema_output=value)
    assert (error.value.code, str(error.value)) == ('invalid', 'The request is invalid.')


@pytest.mark.parametrize('format_', [
    {'type': 'json_object'}, {'type': 'json_schema', 'schema': []},
    {'type': 'json_schema', 'schema': {}}, {'type': 'json_schema', 'schema': 'AUTHOR_SECRET'},
    {**FORMAT, 'repairAttempt': 1}, {**FORMAT, 'unknown': 'AUTHOR_SECRET'},
    {'type': 'json_schema', 'schema': {'value': float('nan')}},
])
def test_unsupported_schema_formats_never_dispatch(monkeypatch, format_):
    seen = transport(monkeypatch)
    with pytest.raises(dspy.LMError) as error:
        asyncio.run(_AsyncEngine('answer', False, True).complete(request(format_)))
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []


@pytest.mark.parametrize('stream,tools,extra', [
    (True, (), {}), (False, (FunctionTool('lookup', 'Look up', {'type': 'object'}),), {}),
    (False, (), {'temperature': 0.2}),
])
def test_schema_neighbours_never_dispatch(monkeypatch, stream, tools, extra):
    seen = transport(monkeypatch)
    async def run():
        engine = _AsyncEngine('answer', True, True)
        value = request(tools=tools, **extra)
        if stream:
            return [part async for part in engine.stream(value)]
        return await engine.complete(value)
    with pytest.raises(dspy.LMError) as error:
        asyncio.run(run())
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []


def test_every_other_config_field_remains_refused(monkeypatch):
    seen = transport(monkeypatch)
    for field in fields(Config):
        if field.name in {'stop', 'tool_choice', 'response_format'}:
            continue
        with pytest.raises(dspy.LMError) as error:
            asyncio.run(_AsyncEngine('answer', False, True).complete(request(**{field.name: 1})))
        assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []
