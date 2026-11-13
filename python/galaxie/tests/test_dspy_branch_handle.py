# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure author synchronization and a test-local explicit branch owner."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from contextvars import ContextVar
import inspect
import json
from typing import Any

import dspy
from galaxie import GalaxieError, _bridge
import galaxie.dspy as face
import pytest

from test_dspy import Question, fields, transport_for
from test_dspy_branches import PAUSE, calling_tasks, execute


class _OwnerGuard:
    """Candidate only: participating callers explicitly enter before a call."""

    def __init__(self):
        self.owners = {}

    @asynccontextmanager
    async def enter(self):
        branch, run = face._branch.get(), face._run.get()
        assert branch is not None and run is not None
        if branch in self.owners:
            run.refuse()
        self.owners[branch] = asyncio.current_task()
        try:
            yield
        finally:
            del self.owners[branch]


def _predictor():
    predictor = dspy.Predict(Question)
    predictor.set_lm(face.GalaxieLM('answer'))
    return predictor


async def _resume(executor, checkpoint, metadata):
    assert executor._restore(checkpoint, metadata, 'session') == 'conversation'
    pending = executor.pending('conversation')
    assert pending is not None
    return await executor.run(None, 'conversation', 50, resume={
        'interactionId': pending['id'], 'action': 'continue', 'payload': None,
    })


def test_lock_recipe_preserves_bytes_under_reversed_transport_completions(calling_tasks):
    async def scenario(reverse):
        seen, completed, gates = [], {}, {}
        order = ['b', 'a'] if reverse else ['a', 'b']

        async def transport(raw):
            message = json.loads(raw)
            seen.append(message)
            content = message['payload']['messages'][-1]['content']
            label, phase = next(value.split(':') for value in ('a:one', 'a:two', 'b:one', 'b:two') if value in content)
            waiting = gates.setdefault(phase, {})
            waiting[label] = asyncio.Event()
            if len(waiting) == 2:
                waiting[order[0]].set()
            await waiting[label].wait()
            completed.setdefault(phase, []).append(label)
            if label == order[0]:
                waiting[order[1]].set()
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')},
                               'kind': 'response', 'ok': True, 'payload': {'content': fields(answer='ok')}})

        _bridge.install_transport(transport)
        predictor = _predictor()

        async def branch(label):
            lock = asyncio.Lock()
            async def call(phase):
                async with lock:
                    return (await predictor.acall(question=f'{label}:{phase}')).answer
            return await asyncio.gather(*(call(phase) for phase in ('one', 'two')))

        async def body():
            result = await face.branches({label: lambda label=label: branch(label) for label in ('a', 'b')})
            face.request_interaction(PAUSE)
            return result

        original = execute(body)
        assert await original.run({}, 'conversation', 50) is None
        checkpoint, metadata = original._snapshot('conversation', 'session')
        journal = json.loads(checkpoint)['journal']
        assert [entry['fanout'] for entry in journal[:-1]] == ['0/a/0', '0/a/1', '0/b/0', '0/b/1']
        assert completed == {'one': order, 'two': order}
        assert await _resume(execute(body), checkpoint, metadata) == {'answer': {'a': ['ok', 'ok'], 'b': ['ok', 'ok']}}
        assert len(seen) == 4
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
        return checkpoint, metadata

    assert asyncio.run(scenario(False)) == asyncio.run(scenario(True))
    assert {kind for kind, _, _ in calling_tasks} == {'model', 'interaction'}


@pytest.mark.parametrize('synchronization', ['lock', 'owner'])
def test_single_awaited_helper_task_is_accepted_and_replayed(synchronization, calling_tasks):
    async def scenario():
        seen, parents = [], []
        transport_for([{'content': fields(answer='ok')}] * 2, seen)
        predictor = _predictor()

        async def branch():
            parents.append(asyncio.current_task())
            lock, owner = asyncio.Lock(), _OwnerGuard()
            async def inner():
                answers = []
                for question in ('one', 'two'):
                    async with (lock if synchronization == 'lock' else owner.enter()):
                        answers.append((await predictor.acall(question=question)).answer)
                return answers
            return await asyncio.create_task(inner())

        async def body():
            result = await face.branches({'a': branch})
            face.request_interaction(PAUSE)
            return result

        original = execute(body)
        assert await original.run({}, 'conversation', 50) is None
        checkpoint, metadata = original._snapshot('conversation', 'session')
        assert await _resume(execute(body), checkpoint, metadata) == {'answer': {'a': ['ok', 'ok']}}
        assert len(seen) == 2
        tasks = [task for kind, key, task in calling_tasks if key == 'a' and kind == 'model']
        for index, parent in enumerate(parents):
            pair = tasks[index * 2:(index + 1) * 2]
            assert len(pair) == 2 and pair[0] is pair[1] and pair[0] is not parent
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]

    asyncio.run(scenario())


@pytest.mark.parametrize('candidate_present', [False, True])
def test_unguarded_calls_keep_arrival_order_hazard(monkeypatch, candidate_present):
    async def scenario(reverse):
        seen, gates = [], {key: asyncio.Event() for key in ('one', 'two')}
        order = ['two', 'one'] if reverse else ['one', 'two']
        gates[order[0]].set()
        caller = ContextVar('branch_handle_caller', default=None)
        original_hop = asyncio.to_thread

        async def ordered_hop(function, /, *args, **kwargs):
            question = caller.get()
            if question is not None:
                await gates[question].wait()
            return await original_hop(function, *args, **kwargs)

        monkeypatch.setattr(asyncio, 'to_thread', ordered_hop)

        async def transport(raw):
            message = json.loads(raw)
            seen.append(message)
            gates[order[1]].set()
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')},
                               'kind': 'response', 'ok': True, 'payload': {'content': fields(answer='ok')}})

        _bridge.install_transport(transport)
        predictor = _predictor()
        candidate = _OwnerGuard() if candidate_present else None

        async def branch():
            async def call(question):
                token = caller.set(question)
                try:
                    return (await predictor.acall(question=question)).answer
                finally:
                    caller.reset(token)
            # Merely constructing a candidate cannot protect unguarded calls.
            assert candidate is None or candidate.owners == {}
            return await asyncio.gather(*(call(question) for question in ('one', 'two')))

        async def body():
            result = await face.branches({'a': branch})
            face.request_interaction(PAUSE)
            return result

        original = execute(body)
        assert await original.run({}, 'conversation', 50) is None
        checkpoint, metadata = original._snapshot('conversation', 'session')
        assert len(seen) == 2
        order.reverse()
        gates = {key: asyncio.Event() for key in ('one', 'two')}
        gates[order[0]].set()
        with pytest.raises(GalaxieError) as caught:
            await _resume(execute(body), checkpoint, metadata)
        assert (caught.value.code, str(caught.value)) == ('unrecoverable', 'Stored state cannot be recovered.')
        assert len(seen) == 2
        return checkpoint, metadata

    forward = asyncio.run(scenario(False))
    # Restore the genuine implementation before setting the next measurement's hop.
    monkeypatch.undo()
    reverse = asyncio.run(scenario(True))
    forward_journal, reverse_journal = (json.loads(value[0])['journal'] for value in (forward, reverse))
    assert [entry['fanout'] for entry in forward_journal[:-1]] == ['0/a/0', '0/a/1']
    assert [entry['digest'] for entry in forward_journal[:-1]] == [entry['digest'] for entry in reversed(reverse_journal[:-1])]
    assert forward[0] != reverse[0]


@pytest.mark.parametrize('reverse', [False, True])
def test_owner_candidate_refuses_second_entry_before_its_dispatch_and_retry_is_not_poisoned(reverse):
    async def scenario():
        seen, children = [], []
        started = asyncio.Event()

        async def transport(raw):
            message = json.loads(raw)
            seen.append(message)
            started.set()
            await asyncio.Event().wait()
            raise AssertionError('The first model request must be cancelled on overlap refusal.')

        _bridge.install_transport(transport)
        predictor = _predictor()
        order = ['two', 'one'] if reverse else ['one', 'two']

        async def branch() -> Any:
            owner = _OwnerGuard()
            async def call(question):
                if question == order[1]:
                    await started.wait()
                async with owner.enter():
                    return await predictor.acall(question=question)
            children.extend(asyncio.create_task(call(question)) for question in order)
            return await asyncio.gather(*children)

        async def body() -> Any:
            face.request_interaction(PAUSE)
            return await face.branches({'a': branch})

        original = execute(body)
        assert await original.run({}, 'conversation', 50) is None
        checkpoint, metadata = original._snapshot('conversation', 'session')
        for retry_order in (order, list(reversed(order))):
            order = retry_order
            started = asyncio.Event()
            restored = execute(body)
            with pytest.raises(GalaxieError) as caught:
                await _resume(restored, checkpoint, metadata)
            assert (caught.value.code, str(caught.value)) == ('unsupported', 'This operation is unsupported.')
            assert restored._sessions['conversation'].unrecoverable is False
            remaining = [task for task in children if not task.done()]
            assert len(remaining) == 1
            for task in remaining:
                task.cancel()
            await asyncio.gather(*children, return_exceptions=True)
            children.clear()
        assert [message['op'] for message in seen] == ['model', 'model']
        for message, first in zip(seen, ('two', 'one') if reverse else ('one', 'two'), strict=True):
            assert first in message['payload']['messages'][-1]['content']
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]

    asyncio.run(scenario())


def test_branch_signature_and_documented_public_names_are_unchanged():
    signature = inspect.signature(face.branches)
    assert list(signature.parameters) == ['group']
    assert signature.parameters['group'].annotation == Mapping[str, Callable[[], Awaitable[Any]]]
    assert signature.return_annotation == dict[str, Any]
    assert {name for name, value in vars(face).items()
            if not name.startswith('_') and getattr(value, '__module__', None) == face.__name__} == {
        'state_binding', 'branches', 'request_interaction', 'GalaxieLM',
        'capability_tool', 'error_code', 'Executor', 'prepare_executor',
    }
