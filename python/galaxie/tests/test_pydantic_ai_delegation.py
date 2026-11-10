# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

import pytest
from pydantic_ai import Agent

from galaxie import GalaxieError, _bridge
from galaxie.pydantic_ai import Executor, GalaxieModel


def test_plain_nested_run_is_refused_before_child_bridge_traffic():
    seen = []

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['payload']['role'])
        reply = {'content': 'done'} if len(seen) > 1 else {
            'content': '', 'toolCalls': [{
                'id': 'delegate-1', 'type': 'function',
                'function': {'name': 'delegate', 'arguments': '{}'},
            }],
        }
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    parent = Agent(GalaxieModel('parent'))
    child = Agent(GalaxieModel('child'))

    @parent.tool_plain
    async def delegate() -> str:
        return (await child.run('child')).output

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 5))
    assert error.value.code == 'unsupported'
    assert seen == ['parent']
