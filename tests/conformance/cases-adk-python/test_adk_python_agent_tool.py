# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""The newly registered native cases keep isolated histories and ordered requests."""

import asyncio
import importlib.util
from pathlib import Path

import pytest


@pytest.mark.parametrize('name', ['agent-tool', 'stream-agent-tool', 'agent-tool-failure'])
def test_native_agent_tool_case(name):
    spec = importlib.util.spec_from_file_location('agent_tool_case_oracle', Path(__file__).with_name('native.py'))
    assert spec is not None and spec.loader is not None
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    transcript = asyncio.run(native.run_case(name))
    inner = [request for request in transcript['requests'] if request['agent'] == 'inner']
    outer = [request for request in transcript['requests'] if request['agent'] == 'outer']
    assert len(inner) == 2
    assert all('ask the specialist' not in str(request['messages']) for request in inner)
    assert transcript['capabilities'] == [{'name': 'math.double@1', 'input': {'value': 3}}]
    if name == 'agent-tool-failure':
        assert len(outer) == 1
        assert transcript['error'] == {'code': 'denied', 'message': 'Policy denied the request.'}
        assert transcript['output'] is None
    else:
        assert len(outer) == 2
        assert transcript['output'] == 'The specialist found 6.'
        assert outer[1]['messages'][-1]['content'] == '{"result":"The result is 6."}'
    if name.startswith('stream-'):
        assert {item['data']['author'] for item in transcript['streams'] if item['mode'] == 'messages'} == {'outer'}
