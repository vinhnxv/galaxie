# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import Any

import dspy
import pytest

from galaxie import GalaxieError, _bridge, capabilities
import galaxie.dspy as face
from test_dspy import FINISH, LOOKUP, SCHEMA, Question, fields, transport_for


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


@pytest.mark.parametrize('mark', ['', '00/a/0', '0/a/01', '1000/a/0', '0/a/100000', '0/bad key/0', '0/' + 'a' * 65 + '/0', 1, None])
def test_restore_rejects_malformed_markers_before_registration(mark):
    checkpoint = {'conversation_id': 'c', 'ordinal': 1, 'pauses': 0, 'input': {}, 'status': 'completed',
                  'journal': [{'kind': 'capability', 'digest': '0' * 64, 'result': 'receipt', 'fanout': mark}]}
    metadata = {'v': 1, 'dspy': dspy.__version__, 'adapter': 'ChatAdapter', 'session': 'session'}
    executor = execute(lambda: asyncio.sleep(0))
    with pytest.raises(GalaxieError) as caught:
        executor._restore(json.dumps(checkpoint).encode(), json.dumps(metadata).encode(), 'session')
    assert caught.value.code == 'unrecoverable'
    assert executor._sessions == {}


@pytest.mark.parametrize('fault', ['duplicate', 'gap', 'order', 'closed', 'wide', 'kind', 'interaction', 'unknown'])
def test_restore_rejects_invalid_journal_structure(fault):
    def entry(mark) -> dict[str, Any]:
        return {'kind': 'capability', 'digest': '0' * 64, 'result': 'receipt', 'fanout': mark}
    journal = [entry('0/a/0')]
    if fault == 'duplicate':
        journal.append(entry('0/a/0'))
    elif fault == 'gap':
        journal.append(entry('0/a/2'))
    elif fault == 'order':
        journal += [entry('1/a/0'), entry('0/b/0')]
    elif fault == 'closed':
        journal += [{'kind': 'capability', 'digest': '0' * 64, 'result': 'root'}, entry('0/b/0')]
    elif fault == 'wide':
        journal = [entry(f'0/key{index}/0') for index in range(33)]
    elif fault in {'kind', 'interaction'}:
        journal[0]['kind'] = 'unknown' if fault == 'kind' else 'interaction'
    else:
        journal[0]['unknown'] = True
    executor = execute(lambda: asyncio.sleep(0))
    raw = {'conversation_id': 'c', 'ordinal': 1, 'pauses': 0, 'input': {}, 'status': 'completed', 'journal': journal}
    metadata = {'v': 1, 'dspy': dspy.__version__, 'adapter': 'ChatAdapter', 'session': 'session'}
    with pytest.raises(GalaxieError) as caught:
        executor._restore(json.dumps(raw).encode(), json.dumps(metadata).encode(), 'session')
    assert caught.value.code == 'unrecoverable' and not executor._sessions


@pytest.mark.parametrize('failure', ['recorded', 'cancelled'])
def test_terminal_failure_and_outer_cancellation_drain_siblings(failure):
    async def scenario():
        started, drained = asyncio.Event(), asyncio.Event()
        async def sibling():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                drained.set()
        async def fail():
            await started.wait()
            if failure == 'recorded':
                raise GalaxieError('denied')
            await asyncio.Event().wait()
        async def body():
            return await face.branches({'sibling': sibling, 'failure': fail})
        task = asyncio.create_task(execute(body).run({}, 'c', 5))
        await started.wait()
        if failure == 'cancelled':
            task.cancel()
        with pytest.raises(GalaxieError) as caught:
            await task
        assert caught.value.code == ('denied' if failure == 'recorded' else 'cancelled')
        assert drained.is_set()
        assert not [other for other in asyncio.all_tasks() if other is not asyncio.current_task() and not other.done()]
    asyncio.run(scenario())


def test_outer_cancellation_prevents_dispatch_from_a_branch_that_catches_it():
    async def scenario():
        started = asyncio.Event()
        requests = []
        async def transport(raw):
            message = json.loads(raw)
            requests.append(message)
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': True, 'payload': 'receipt'})
        _bridge.install_transport(transport)
        async def branch():
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return await capabilities.call('write@1', {})
        async def body():
            return await face.branches({'survivor': branch})
        task = asyncio.create_task(execute(body).run({}, 'c', 5))
        await started.wait()
        task.cancel()
        with pytest.raises(GalaxieError) as caught:
            await task
        assert caught.value.code == 'cancelled'
        assert requests == []
        assert not [other for other in asyncio.all_tasks() if other is not asyncio.current_task() and not other.done()]
    asyncio.run(scenario())


def test_silent_groups_and_branches_replay_without_consuming_root_scopes():
    async def scenario():
        seen = []
        async def transport(raw):
            message = json.loads(raw)
            seen.append(message['payload']['effectScope'])
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': True, 'payload': 'receipt'})
        _bridge.install_transport(transport)
        async def silent():
            return 'silent'
        async def write():
            return await capabilities.call('write@1', {})
        async def body():
            assert await face.branches({}) == {}
            await face.branches({'silent': silent})
            await face.branches({'write': write, 'silent': silent})
            await write()
            face.request_interaction(PAUSE)
            return 'done'
        executor = execute(body)
        assert await executor.run({}, 'c', 5) is None
        assert seen == ['dspy/c/1/1/write/0', 'dspy/c/1/0']
        checkpoint, metadata = executor._snapshot('c', 'session')
        restored = execute(body)
        restored._restore(checkpoint, metadata, 'session')
        before = restored.pending('c')
        assert before is not None
        assert await restored.run(None, 'c', 5, resume={'interactionId': before['id'], 'action': 'continue', 'payload': None}) == {'answer': 'done'}
        assert len(seen) == 2
    asyncio.run(scenario())


def test_duplicate_mapping_keys_and_nonmapping_are_refused():
    from collections.abc import Mapping
    class Duplicate(Mapping):
        def __iter__(self):
            return iter(['a', 'a'])
        def __len__(self):
            return 2
        def __getitem__(self, key):
            return lambda: asyncio.sleep(0)
    for group in [Duplicate(), []]:
        async def body():
            try:
                await face.branches(group)
            except BaseException:
                pass
        with pytest.raises(GalaxieError) as caught:
            asyncio.run(execute(body).run({}, 'c', 5))
        assert caught.value.code == 'unsupported'


def test_thread_pool_call_inside_branch_keeps_fixed_refusal():
    async def body():
        async def threaded():
            predictor = dspy.Predict('question -> answer')
            predictor.set_lm(face.GalaxieLM('answer'))
            return dspy.Parallel(num_threads=2, disable_progress_bar=True)([(predictor, {'question': 'one'})])
        return await face.branches({'threaded': threaded})
    with pytest.raises(GalaxieError) as caught:
        asyncio.run(execute(body).run({}, 'c', 5))
    assert caught.value.code == 'unsupported'


def test_streaming_refusal_survives_author_catch_without_transport():
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(face.GalaxieLM('answer'))
        async def aforward(self, question):
            try:
                await face.branches({'a': lambda: self.predict.acall(question=question)})
            except BaseException:
                pass
            return dspy.Prediction(answer='caught')
    async def transport(raw):
        raise AssertionError('Streaming fan-out must fail before dispatch.')
    _bridge.install_transport(transport)
    executor = face.Executor(Program(), stream_fields=['answer'])
    with pytest.raises(GalaxieError) as caught:
        asyncio.run(executor.run({'question': 'test'}, 'c', 5, on_stream=lambda *_: None))
    assert caught.value.code == 'unsupported'


@pytest.fixture
def calling_tasks(monkeypatch):
    observed = []
    original = face._Run.begin
    def begin(run, kind, payload):
        branch = face._branch.get()
        observed.append((kind, branch.key if branch else None, asyncio.current_task()))
        return original(run, kind, payload)
    monkeypatch.setattr(face._Run, 'begin', begin)
    return observed


@pytest.mark.parametrize('inline', [False, True])
@pytest.mark.parametrize('shape', ['predict', 'react', 'wait_for', 'timeout'])
def test_sequential_branch_calling_task_identity(monkeypatch, calling_tasks, inline, shape):
    if inline:
        async def to_thread(function, /, *args, **kwargs):
            await asyncio.sleep(0)
            return function(*args, **kwargs)
        monkeypatch.setattr(asyncio, 'to_thread', to_thread)
    seen = []
    transport_for([LOOKUP, 'receipt', FINISH] if shape == 'react' else
                  [{'content': fields(answer='ok')}] * 3, seen)
    module = (dspy.ReAct(Question, tools=[face.capability_tool('lookup@1', 'Look up', SCHEMA, tool_name='lookup')], max_iters=1)
              if shape == 'react' else dspy.Predict(Question))
    module.set_lm(face.GalaxieLM('answer'))
    owners = []
    async def branch():
        owners.append(asyncio.current_task())
        if shape == 'react':
            return (await module.acall(question='q')).answer
        answers = []
        for _ in range(3):
            if shape == 'wait_for':
                result = await asyncio.wait_for(module.acall(question='q'), 60)
            elif shape == 'timeout':
                async with asyncio.timeout(60):
                    result = await module.acall(question='q')
            else:
                result = await module.acall(question='q')
            answers.append(result.answer)
        return answers
    async def body():
        return await face.branches({'a': branch})
    assert asyncio.run(execute(body).run({}, 'c', 50)) == {'answer': {'a': 'Paris' if shape == 'react' else ['ok'] * 3}}
    assert [message['op'] for message in seen] == (['model', 'capability', 'model'] if shape == 'react' else ['model'] * 3)
    assert [(kind, key) for kind, key, _ in calling_tasks] == [(message['op'], 'a') for message in seen]
    assert all(task is owners[0] for _, _, task in calling_tasks)


@pytest.fixture
def first_caller_proposal(monkeypatch):
    """Reproduce the rejected guard without changing the shipped helper."""
    original = face._Run.begin
    tasks, runs = {}, []
    def begin(run, kind, payload):
        run.check()
        branch = face._branch.get()
        if branch is not None:
            key = (id(run), branch.group, branch.key)
            task = asyncio.current_task()
            if key not in tasks:
                tasks[key] = task
                runs.append(run)
            if task is None or tasks[key] is not task:
                run.refuse()
        return original(run, kind, payload)
    monkeypatch.setattr(face._Run, 'begin', begin)


@pytest.mark.parametrize('reverse', [False, True])
def test_first_caller_proposal_refuses_immediate_overlap_but_one_write_already_ran(first_caller_proposal, reverse):
    seen = []
    transport_for(['receipt'] * 3, seen)
    async def branch():
        order = ['b', 'a'] if reverse else ['a', 'b']
        await asyncio.gather(*(capabilities.call('write@1', {'query': key}) for key in order))
    async def body():
        try:
            await face.branches({'a': branch})
        except BaseException:
            pass
        return await capabilities.call('write@1', {'query': 'caught'})
    with pytest.raises(GalaxieError) as caught:
        asyncio.run(execute(body).run({}, 'c', 50))
    assert caught.value.code == 'unsupported'
    assert len(seen) == 1
    assert seen[0]['payload']['input'] == {'query': 'b' if reverse else 'a'}


def test_first_caller_proposal_poisoning_on_reversed_retry(first_caller_proposal):
    async def scenario():
        effects, seen = {}, []
        async def transport(raw):
            message = json.loads(raw)
            payload = message['payload']
            seen.append(message)
            code = None
            if message['op'] == 'model':
                result = {'content': fields(answer='ok')}
            else:
                scope, digest = payload['effectScope'], face._digest(payload['input'])
                if scope in effects and effects[scope] != digest:
                    code = 'unrecoverable'
                else:
                    effects[scope] = digest
                result = 'receipt'
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': code is None,
                               **({'error': {'code': code}} if code else {'payload': result})})
        _bridge.install_transport(transport)
        reverse = False
        predict = dspy.Predict(Question)
        predict.set_lm(face.GalaxieLM('answer'))
        async def branch():
            gates = {key: asyncio.Event() for key in ('a', 'b')}
            order = ['b', 'a'] if reverse else ['a', 'b']
            gates[order[0]].set()
            async def write(key):
                await gates[key].wait()
                try:
                    await predict.acall(question=key)
                    return await capabilities.call('write@1', {'query': key})
                finally:
                    gates[order[1]].set()
            await asyncio.gather(*(write(key) for key in order))
        async def body():
            face.request_interaction(PAUSE)
            return await face.branches({'a': branch})
        original = execute(body)
        assert await original.run({}, 'c', 50) is None
        checkpoint, metadata = original._snapshot('c', 'session')
        outcomes = []
        for reverse in (False, True):
            restored = execute(body)
            restored._restore(checkpoint, metadata, 'session')
            pending = restored.pending('c')
            assert pending is not None
            with pytest.raises(GalaxieError) as caught:
                await restored.run(None, 'c', 50, resume={'interactionId': pending['id'], 'action': 'continue', 'payload': None})
            outcomes.append(caught.value.code)
            assert restored._sessions['c'].unrecoverable is reverse
        assert outcomes == ['unsupported', 'unrecoverable']
        writes = [message['payload'] for message in seen if message['op'] == 'capability']
        assert [write['input'] for write in writes] == [{'query': 'a'}, {'query': 'b'}]
        assert [write['effectScope'] for write in writes] == ['dspy/c/1/0/a/1'] * 2
        assert len(effects) == 1
    asyncio.run(scenario())


@pytest.mark.parametrize('bare', [False, True])
def test_first_caller_proposal_leaves_an_author_child_but_blocks_later_requests(first_caller_proposal, bare):
    async def scenario():
        seen, children, outcomes = [], [], []
        started, release = asyncio.Event(), asyncio.Event()
        transport_for(['receipt'] * 3, seen)
        async def child():
            children.append(asyncio.current_task())
            started.set()
            await release.wait()
            try:
                await capabilities.call('write@1', {'query': 'late'})
            except BaseException as error:
                outcomes.append(face.error_code(error))
        async def overlap():
            await started.wait()
            await asyncio.gather(capabilities.call('write@1', {'query': 'a'}),
                                 capabilities.call('write@1', {'query': 'b'}))
        async def branch():
            if bare:
                asyncio.create_task(child())
                await overlap()
            else:
                await asyncio.gather(child(), overlap())
        async def body():
            return await face.branches({'a': branch})
        baseline = asyncio.all_tasks()
        try:
            with pytest.raises(GalaxieError) as caught:
                await execute(body).run({}, 'c', 50)
            assert caught.value.code == 'unsupported'
            for _ in range(3):
                await asyncio.sleep(0)
            assert len(seen) == 1
            assert asyncio.all_tasks() - baseline == set(children)
            assert len(children) == 1
            release.set()
            await asyncio.gather(*children)
            assert outcomes == ['unsupported'] and len(seen) == 1
            assert asyncio.all_tasks() == baseline
        finally:
            for task in children:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*children, return_exceptions=True)
    asyncio.run(scenario())


def test_single_helper_task_keeps_sequential_calls_and_replay(calling_tasks):
    async def scenario():
        seen, owners = [], []
        transport_for(['receipt'] * 3, seen)
        async def branch():
            owners.append(asyncio.current_task())
            async def inner():
                return [await capabilities.call('write@1', {'query': key}) for key in ('a', 'b', 'c')]
            return await asyncio.create_task(inner())
        async def body():
            result = await face.branches({'a': branch})
            face.request_interaction(PAUSE)
            return result
        original = execute(body)
        assert await original.run({}, 'c', 50) is None
        checkpoint, metadata = original._snapshot('c', 'session')
        restored = execute(body)
        restored._restore(checkpoint, metadata, 'session')
        pending = restored.pending('c')
        assert pending is not None
        assert await restored.run(None, 'c', 50, resume={'interactionId': pending['id'], 'action': 'continue', 'payload': None}) == {'answer': {'a': ['receipt'] * 3}}
        assert len(seen) == 3
        tasks = [task for _, key, task in calling_tasks if key == 'a']
        for index, owner in enumerate(owners):
            calls = tasks[index * 3:(index + 1) * 3]
            assert len(set(calls)) == 1 and calls[0] is not owner
    asyncio.run(scenario())


@pytest.mark.parametrize('first', ['a', 'b'])
def test_concurrent_terminal_failures_report_first_recorded_code_and_drain(first):
    async def scenario():
        started = {key: asyncio.Event() for key in ('a', 'b')}
        release = asyncio.Event()
        failures, drained = [], []
        codes = {'a': 'denied', 'b': 'unavailable'}
        async def fail(key):
            started[key].set()
            await started['b' if key == 'a' else 'a'].wait()
            try:
                if key == first:
                    release.set()
                else:
                    await release.wait()
                failures.append(key)
                raise GalaxieError(codes[key])
            finally:
                drained.append(key)
        async def body():
            return await face.branches({'a': lambda: fail('a'), 'b': lambda: fail('b')})
        with pytest.raises(GalaxieError) as caught:
            await execute(body).run({}, 'conversation', 5)
        assert failures == [first, 'b' if first == 'a' else 'a']
        assert caught.value.code == codes[first]
        assert sorted(drained) == ['a', 'b']
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
    asyncio.run(scenario())
