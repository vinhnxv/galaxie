# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import Any

import dspy
import pytest

from galaxie import GalaxieError, _bridge, capabilities
import galaxie.dspy as face


PAUSE = {'surfaceId': 'review', 'viewRevision': '1', 'component': 'ui.review/v1', 'props': {}}


def execute(body, *, streaming=False):
    class Program(dspy.Module):
        async def aforward(self):
            return dspy.Prediction(answer=await body())
    return face.Executor(Program(), stream_fields=['answer'] if streaming else ())


def test_branch_scopes_checkpoint_and_replay_are_order_independent():
    async def scenario(reverse):
        seen = []
        events = {key: asyncio.Event() for key in ('a', 'b', 'c')}
        order = ['c', 'b', 'a'] if reverse else ['a', 'b', 'c']
        async def transport(raw):
            message = json.loads(raw)
            seen.append(message['payload'])
            key = message['payload']['input']['query']
            await events[key].wait()
            index = order.index(key)
            if index < 2:
                events[order[index + 1]].set()
            return json.dumps({**{k: message[k] for k in ('v', 'id', 'op')}, 'kind': 'response', 'ok': True, 'payload': 'receipt:' + key})
        _bridge.install_transport(transport)
        async def body():
            events[order[0]].set()
            async def branch(key):
                return await capabilities.call('write@1', {'query': key})
            results = await face.branches({key: lambda key=key: branch(key) for key in ('a', 'b', 'c')})
            face.request_interaction(PAUSE)
            return results
        executor = execute(body)
        assert await executor.run({}, 'conversation', 50) is None
        checkpoint, metadata = executor._snapshot('conversation', 'session')
        scopes = {item['input']['query']: item['effectScope'] for item in seen}
        assert scopes == {key: f'dspy/conversation/1/0/{key}/0' for key in ('a', 'b', 'c')}
        restored = execute(body)
        assert restored._restore(checkpoint, metadata, 'session') == 'conversation'
        pending = restored._sessions['conversation'].pending
        assert pending is not None
        assert await restored.run(None, 'conversation', 50, resume={'interactionId': pending['id'], 'action': 'continue', 'payload': None}) == {'answer': {key: 'receipt:' + key for key in ('a', 'b', 'c')}}
        assert len(seen) == 3
        return checkpoint, metadata
    assert asyncio.run(scenario(False)) == asyncio.run(scenario(True))


@pytest.mark.parametrize('shape', ['pause', 'nested', 'wide', 'key', 'value', 'groups', 'concurrent', 'root'])
def test_refusals_are_fixed_and_survive_author_catches(shape):
    async def body():
        async def silent():
            return None
        async def bad():
            if shape == 'pause':
                face.request_interaction(PAUSE)
            elif shape == 'nested':
                await face.branches({'nested': silent})
            elif shape == 'concurrent':
                await asyncio.gather(capabilities.call('write@1', {}), capabilities.call('write@1', {}))
            else:
                await silent()
        try:
            if shape == 'root':
                gate = asyncio.Event()
                async def child():
                    gate.set()
                    await asyncio.Event().wait()
                task = asyncio.create_task(face.branches({'a': child}))
                await gate.wait()
                try:
                    await capabilities.call('write@1', {})
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            elif shape == 'groups':
                for _ in range(1001):
                    await face.branches({'a': silent})
            else:
                group: Any = {str(i): bad for i in range(33)} if shape == 'wide' else {'bad/key' if shape == 'key' else 'a': None if shape == 'value' else bad}
                await face.branches(group)
        except BaseException:
            pass
        return 'caught'
    async def transport(raw):
        await asyncio.Event().wait()
        raise AssertionError('The blocked request must be cancelled.')
    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError, match='^This operation is unsupported\\.$') as error:
        asyncio.run(execute(body).run({}, 'c', 50))
    assert error.value.code == 'unsupported'


def test_empty_and_outside_run():
    with pytest.raises(GalaxieError) as error:
        asyncio.run(face.branches({}))
    assert error.value.code == 'unsupported'
    async def body():
        assert await face.branches({}) == {}
        return await face.branches({'silent': lambda: asyncio.sleep(0, result='ok')})
    assert asyncio.run(execute(body).run({}, 'c', 5)) == {'answer': {'silent': 'ok'}}


def test_ordinary_exceptions_wait_all_and_raise_in_input_order():
    finished = []
    async def body():
        async def fail(message):
            if message == 'first':
                await asyncio.sleep(0)
            raise ValueError(message)
        async def finish():
            await asyncio.sleep(0)
            finished.append('finished')
        try:
            await face.branches({'a': lambda: fail('first'), 'b': lambda: fail('second'), 'c': finish})
        except ValueError as error:
            return str(error)
    assert asyncio.run(execute(body).run({}, 'c', 5)) == {'answer': 'first'}
    assert finished == ['finished']
