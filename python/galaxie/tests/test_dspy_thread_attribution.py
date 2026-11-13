# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native attribution boundaries and DSPy's unchanged refusal logging."""

import asyncio
import contextvars
import gc
import logging
import threading
from typing import Any

import dspy
import pytest
from dspy.dsp.utils.settings import thread_local_overrides

from galaxie import GalaxieError
from galaxie.dspy import Executor, GalaxieLM, _AsyncEngine
from test_dspy import fields, native_request, transport_for


@pytest.mark.parametrize('kind,threads', [('parallel', 1), ('parallel', 3), ('async-n2', 3)])
def test_refusal_logging_policy(caplog: Any, kind: str, threads: int) -> None:
    class Program(dspy.Module):
        def __init__(self) -> None:
            self.predict = dspy.Predict('question -> answer', n=2) if kind == 'async-n2' else dspy.Predict('question -> answer')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self) -> Any:
            examples = [dspy.Example(question=f'private-item-{index}').with_inputs('question') for index in range(3)]
            def call(question: str) -> Any:
                return asyncio.run(self.predict.acall(question=question))
            return dspy.Parallel(num_threads=threads, disable_progress_bar=True)([(call if kind == 'async-n2' else self.predict, item) for item in examples])

    seen: list[Any] = []
    transport_for([], seen)
    logger = logging.getLogger('dspy.utils.parallelizer')
    logger.addHandler(caplog.handler)
    try:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(Executor(Program()).run({}, 'c', 5))
    finally:
        logger.removeHandler(caplog.handler)
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert 'private-item' not in str(error.value)
    records = [record for record in caplog.records if record.name == logger.name]
    assert not any(record.name.startswith('galaxie') for record in caplog.records)
    if threads == 1:
        assert len(records) == 1
        for index, record in enumerate(records):
            assert f'private-item-{index}' in record.getMessage()
            assert record.getMessage().endswith(': This operation is unsupported.. Set `provide_traceback=True` for traceback.')
    else:
        assert records == []
    assert seen == []


@pytest.mark.parametrize('route', ['thread', 'executor', 'bare', 'bare-caught'])
def test_runless_async_calls_refuse_without_terminating_an_unidentified_run(route: str) -> None:
    failures: list[str | None] = []
    class Program(dspy.Module):
        def __init__(self) -> None:
            self.predict = dspy.Predict('question -> answer')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self) -> Any:
            async def call() -> Any:
                return await self.predict.acall(question='q')
            def worker() -> None:
                try:
                    asyncio.run(call())
                except dspy.LMError as error:
                    failures.append(error.code)
            if route == 'thread':
                thread = threading.Thread(target=worker)
                thread.start()
                thread.join()
            elif route == 'executor':
                await asyncio.get_running_loop().run_in_executor(None, worker)
            else:
                task = asyncio.create_task(call(), context=contextvars.Context())
                try:
                    await task
                except BaseException:
                    if route != 'bare-caught':
                        raise
            return dspy.Prediction(answer='fallback')

    seen: list[Any] = []
    transport_for([{'content': fields(answer='unjournaled')}], seen)
    executor = Executor(Program())
    if route == 'bare':
        with pytest.raises(GalaxieError) as error:
            asyncio.run(executor.run({}, 'c', 5))
        assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    else:
        assert asyncio.run(executor.run({}, 'c', 5)) == {'answer': 'fallback'}
    assert seen == []
    if route in ('thread', 'executor'):
        assert failures == ['unsupported']


@pytest.mark.parametrize('entry', ['complete', 'stream'])
def test_runless_engine_entries_refuse_before_payload_construction(entry: str) -> None:
    class Program(dspy.Module):
        async def aforward(self) -> Any:
            async def call() -> None:
                engine = _AsyncEngine('answer', True)
                # Invalid input proves the guard precedes reading the payload.
                if entry == 'complete':
                    await engine.complete(None)  # type: ignore[arg-type]
                else:
                    async for _ in engine.stream(None):  # type: ignore[arg-type]
                        pass
            await asyncio.create_task(call(), context=contextvars.Context())
    seen: list[Any] = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program()).run({}, 'c', 5))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('ending', ['success', 'failure', 'cancelled'])
def test_standalone_model_call_after_run_cleanup(ending: str) -> None:
    class Program(dspy.Module):
        async def aforward(self) -> Any:
            if ending == 'failure':
                raise ValueError('private')
            if ending == 'cancelled':
                raise asyncio.CancelledError()
            return dspy.Prediction(answer='ok')
    executor = Executor(Program())
    if ending == 'success':
        assert asyncio.run(executor.run({}, 'c', 5)) == {'answer': 'ok'}
    else:
        with pytest.raises(GalaxieError):
            asyncio.run(executor.run({}, 'c', 5))
    seen: list[Any] = []
    transport_for([{'content': 'standalone'}], seen)
    reply = asyncio.run(GalaxieLM('answer', native_tools=True).acall(native_request()))
    assert reply.message.parts[0].text == 'standalone'
    assert len(seen) == 1


def test_overlapping_runs_and_context_carrying_native_threads() -> None:
    class Program(dspy.Module):
        def __init__(self) -> None:
            self.predict = dspy.Predict('question -> answer')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question: str) -> Any:
            def worker() -> Any:
                return asyncio.run(self.predict.acall(question=question))
            if question == 'to-thread':
                return await asyncio.to_thread(worker)
            results: list[Any] = []
            thread = threading.Thread(target=lambda: results.append(worker()), context=contextvars.copy_context())
            thread.start()
            thread.join()
            return results[0]
    seen: list[Any] = []
    transport_for([{'content': fields(answer='ok')}] * 3, seen)
    executor = Executor(Program())
    async def overlap() -> Any:
        return await asyncio.gather(executor.run({'question': 'to-thread'}, 'a', 5), executor.run({'question': 'copy'}, 'b', 5))
    assert asyncio.run(overlap()) == [{'answer': 'ok'}, {'answer': 'ok'}]
    assert len(seen) == 2
    assert all(len(executor._sessions[key].journal) == 1 for key in ('a', 'b'))
    asyncio.run(GalaxieLM('answer', native_tools=True).acall(native_request()))
    assert len(seen) == 3


def test_stale_settings_cannot_terminate_a_later_run() -> None:
    captured: list[Any] = []
    failures: list[str | None] = []
    class Earlier(dspy.Module):
        async def aforward(self) -> Any:
            captured.append(thread_local_overrides.get().copy())
            return dspy.Prediction(answer='earlier')
    assert asyncio.run(Executor(Earlier()).run({}, 'a', 5)) == {'answer': 'earlier'}
    gc.collect()
    assert captured[0]['galaxie_run']() is None
    class Later(dspy.Module):
        async def aforward(self) -> Any:
            def worker() -> None:
                thread_local_overrides.set(captured[0])
                try:
                    asyncio.run(GalaxieLM('answer', native_tools=True).acall(native_request()))
                except dspy.LMError as error:
                    failures.append(error.code)
            thread = threading.Thread(target=worker)
            thread.start()
            thread.join()
            return dspy.Prediction(answer='later')
    seen: list[Any] = []
    transport_for([], seen)
    assert asyncio.run(Executor(Later()).run({}, 'b', 5)) == {'answer': 'later'}
    assert failures == ['unsupported']
    assert seen == []


@pytest.mark.parametrize('chain,code', [('cause', 'unsupported'), ('context', 'unsupported'), ('group', 'unsupported'), ('hidden', 'executor_error'), ('cycle', 'executor_error'), ('deep', 'executor_error'), ('ordinary', 'executor_error'), ('swallowed', None)])
def test_thread_start_exception_chains(monkeypatch: Any, chain: str, code: str | None) -> None:
    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError('private thread failure')
    monkeypatch.setattr(threading, '_start_joinable_thread', boom)
    class Program(dspy.Module):
        async def aforward(self) -> Any:
            if chain == 'ordinary':
                raise RuntimeError('private author failure')
            try:
                threading.Thread(target=lambda: None).start()
            except RuntimeError as error:
                if chain == 'cause':
                    raise ValueError('private wrapper') from error
                if chain == 'context':
                    raise ValueError('private wrapper')
                if chain == 'group':
                    try:
                        raise ValueError('private wrapper') from error
                    except ValueError as wrapped:
                        raise ExceptionGroup('private group', [wrapped])
                if chain == 'hidden':
                    raise ValueError('private wrapper') from None
                if chain == 'cycle':
                    first, second = ValueError('private a'), ValueError('private b')
                    first.__cause__, second.__cause__ = second, first
                    raise first
                if chain == 'deep':
                    outer: BaseException = error
                    for _ in range(40):
                        wrapper = ValueError('private wrapper')
                        wrapper.__cause__ = outer
                        outer = wrapper
                    raise outer
            return dspy.Prediction(answer='fallback')
    seen: list[Any] = []
    transport_for([], seen)
    if code is None:
        assert asyncio.run(Executor(Program()).run({}, 'c', 5)) == {'answer': 'fallback'}
    else:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(Executor(Program()).run({}, 'c', 5))
        assert error.value.code == code
        assert 'private' not in str(error.value)
        if code == 'unsupported':
            assert str(error.value) == 'This operation is unsupported.'
    assert seen == []


def test_runless_guard_is_thread_safe_during_run_lifetimes() -> None:
    from galaxie import dspy as integration
    barrier = threading.Barrier(21)
    outcomes: list[str | None] = []
    def worker() -> None:
        for _ in range(20):
            barrier.wait(timeout=10)
            try:
                integration._refuse_runless()
                outcomes.append('normal')
            except dspy.LMError as error:
                outcomes.append(error.code)
            barrier.wait(timeout=10)
    class Program(dspy.Module):
        async def aforward(self) -> Any:
            barrier.wait(timeout=10)
            barrier.wait(timeout=10)
            return dspy.Prediction(answer='ok')
    threads = [threading.Thread(target=worker) for _ in range(20)]
    for thread in threads:
        thread.start()
    executor = Executor(Program())
    for index in range(10):
        assert asyncio.run(executor.run({}, str(index), 5)) == {'answer': 'ok'}
        barrier.wait(timeout=10)
        barrier.wait(timeout=10)
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()
    assert outcomes.count('unsupported') == 200
    assert outcomes.count('normal') == 200
    assert integration._active_runs == 0
