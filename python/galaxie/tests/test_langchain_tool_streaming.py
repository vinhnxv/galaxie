# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import sys
from pathlib import Path

import pytest
from langchain_core.messages import AIMessageChunk, HumanMessage

from galaxie import GalaxieError, _bridge
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests/conformance/cases-python'))
from tool_streaming_candidate import bound, serialization


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('split_ids', [False, True])
def test_split_id_counterexample_and_valid_interleaved_merge(parallel, split_ids):
    deltas = [
        {'index': 0, 'id': 'call-' if split_ids else 'call-1', 'function': {'name': 're', 'arguments': '{"va'}},
        *([{'index': 1, 'id': 'other-' if split_ids else 'other-2', 'function': {'name': 'oth', 'arguments': '{"value":'}}] if parallel else []),
        {'index': 0, **({'id': '1'} if split_ids else {}), 'function': {'name': 'ad', 'arguments': 'lue":'}},
        *([{'index': 1, **({'id': '2'} if split_ids else {}), 'function': {'name': 'er', 'arguments': '3'}}] if parallel else []),
        {'index': 0, 'function': {'arguments': '2}'}},
        *([{'index': 1, 'function': {'arguments': '}'}}] if parallel else []),
    ]
    native = AIMessageChunk(content='')
    for call in deltas:
        native += AIMessageChunk(content='', tool_call_chunks=[{
            'index': call['index'], 'id': call.get('id'), 'name': call['function'].get('name'),
            'args': call['function'].get('arguments'),
        }])
    operations = []

    async def transport(raw):
        message = json.loads(raw)
        operations.append(message['op'])
        assert message['payload']['options']['stream'] is True
        for call in deltas:
            assert operations == ['model']
            _bridge.receive_model_chunk(json.dumps({'v': _bridge.VERSION, 'kind': 'notify',
                'id': message['id'], 'op': 'model-chunk', 'payload': {'content': '', 'toolCalls': [call]}}))
            await asyncio.sleep(0)
        return json.dumps({key: message[key] for key in ('v', 'id', 'op')} | {
            'kind': 'response', 'ok': True, 'payload': {'content': '', 'toolCalls': [{
                'id': call['id'], 'type': 'function', 'function': {'name': call['name'], 'arguments': json.dumps(call['args'])},
            } for call in ([{'id': 'call-1', 'name': 'read', 'args': {'value': 2}}] +
                          ([{'id': 'other-2', 'name': 'other', 'args': {'value': 3}}] if parallel else []))]}})

    _bridge.install_transport(transport)

    async def run():
        combined = AIMessageChunk(content='')
        async for chunk in bound().astream([HumanMessage('request')]):
            combined += chunk
        return combined

    if split_ids:
        assert native.invalid_tool_calls
        with pytest.raises(GalaxieError) as error:
            asyncio.run(run())
        assert error.value.code == 'invalid'
        assert operations == ['model']
        return
    actual = asyncio.run(run())
    assert actual.tool_calls == native.tool_calls
    assert [call['id'] for call in actual.tool_calls] == (['call-1', 'other-2'] if parallel else ['call-1'])
    assert operations == ['model']


@pytest.mark.parametrize('form,code', [('string', None), ('list', 'unsupported'),
    ('error', 'unsupported'), ('artifact', 'unsupported'), ('unknown', 'invalid')])
def test_tool_message_serialization_forms(form, code):
    if code is None:
        assert serialization(form) == {'role': 'tool', 'content': '4', 'tool_call_id': 'call-1'}
    else:
        with pytest.raises(GalaxieError) as error:
            serialization(form)
        assert error.value.code == code
