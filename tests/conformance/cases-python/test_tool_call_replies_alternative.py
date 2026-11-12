# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import sys
from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from galaxie import _bridge, langgraph

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_tool_call_replies_native import native_record
from tool_loop import create_agent


@pytest.mark.parametrize('scenario,stream', [('read', False), ('read', True), ('write', False), ('parallel', False)])
def test_text_protocol_matches_native_ordered_broker_calls_write_count_and_final_text(monkeypatch, scenario, stream):
    async def exercise():
        reference, _ = await native_record(write_only=scenario == 'write', parallel=scenario == 'parallel')
        calls = []
        requests = []

        async def transport(raw):
            request = json.loads(raw)
            requests.append(request)
            payload = request['payload']
            if request['op'] == 'capability':
                assert 'tool' not in payload  # Direct calls retain their existing policy boundary.
                calls.append([payload['name'], payload['input']])
                result = '4' if payload['name'] == 'read@1' else 'saved'
            else:
                text = (json.dumps({'calls': [{'name': name, 'input': value} for name, value in reference['calls']]})
                        if len(payload['messages']) == 1 else 'done')
                if payload['options'].get('stream'):
                    for delta in [text[:5], text[5:]]:
                        _bridge.receive_model_chunk(json.dumps({
                            'v': request['v'], 'kind': 'notify', 'id': request['id'],
                            'op': 'model-chunk', 'payload': {'content': delta},
                        }))
                result = {'content': text}
            return json.dumps({key: request[key] for key in ('v', 'id', 'op')} | {
                'kind': 'response', 'ok': True, 'payload': result,
            })

        monkeypatch.setattr(langgraph, '_checkpointer', InMemorySaver())
        _bridge.install_transport(transport)
        graph = create_agent()
        result = await graph.ainvoke({'scenario': scenario, 'stream': stream}, {'configurable': {'thread_id': 'alternative'}})
        assert result == {'final': reference['final'], 'calls': reference['calls']}
        assert calls == reference['calls']
        assert sum(name == 'write@1' for name, _ in calls) == reference['writes']
        model_requests = [request for request in requests if request['op'] == 'model']
        assert len(model_requests) == 2
        assert all('tools' not in request['payload']['options'] for request in model_requests)
    asyncio.run(exercise())
