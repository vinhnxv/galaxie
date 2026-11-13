# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Runtime provider LMs fail before payload construction or engine execution."""

import asyncio
import contextvars
import subprocess
import sys
from typing import Any
from unittest.mock import patch

import dspy
import pytest
from dspy.lm15 import Message, Request, Response, TextPart, Usage

from galaxie import GalaxieError
from galaxie import dspy as integration
from galaxie.dspy import Executor, GalaxieLM
from test_dspy import fields, transport_for


class Engine:
    def complete(self, value: Request) -> Response:
        return Response(id='fixture', model=value.model, message=Message(role='assistant', parts=(TextPart(text='standalone'),)), finish_reason='stop', usage=Usage())


class AsyncEngine:
    async def complete(self, value: Request) -> Response:
        return Engine().complete(value)


def plain() -> dspy.LM:
    return dspy.LM('offline', engine=Engine(), async_engine=AsyncEngine(), cache=False, num_retries=0)


class Program(dspy.Module):
    def __init__(self, route: str) -> None:
        super().__init__()
        self.route = route
        self.predict = dspy.Predict('question -> answer')
        self.predict.set_lm(GalaxieLM('answer'))

    async def aforward(self) -> Any:
        lm = plain() if self.route in ('engine', 'sync', 'caught', 'parallel') else dspy.LM(
            'openai/x', api_base='http://127.0.0.1:9', api_key='fixture-not-a-credential', cache=False, num_retries=0)
        if self.route == 'context':
            self.predict.lm = None
            with dspy.context(lm=lm):
                return await self.predict.acall(question='q')
        if self.route == 'sync':
            return lm(object())
        if self.route == 'caught':
            try:
                await lm.acall(object())
            except Exception:
                return dspy.Prediction(answer='caught')
        if self.route == 'parallel':
            # DSPy's pool carries settings, without the galaxie ContextVar.
            def call(question: str) -> Any:
                return lm(question)
            dspy.Parallel(num_threads=2, disable_progress_bar=True)([
                (call, dspy.Example(question='q').with_inputs('question'))])
            return dspy.Prediction(answer='caught by pool')
        self.predict.set_lm(lm)
        return await self.predict.acall(question='q')


@pytest.mark.parametrize('route', ['set', 'context', 'engine', 'sync', 'caught', 'parallel'])
def test_runtime_plain_lm_refuses_before_any_connection_or_bridge_request(route: str, monkeypatch: Any) -> None:
    # Match the Worker driver: model metadata comes from DSPy's pinned snapshot.
    monkeypatch.setenv('LITELLM_LOCAL_MODEL_COST_MAP', 'true')
    seen: list[Any] = []
    transport_for([], seen)
    program = Program(route)
    with patch('socket.socket.connect', side_effect=AssertionError('Unexpected connection.')) as connect:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(Executor(program).run({}, 'c', 5))
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []
    connect.assert_not_called()
    assert integration._active_runs == 0


def test_unattributed_plain_lm_refuses_without_poisoning_an_active_run() -> None:
    class Unattributed(dspy.Module):
        async def aforward(self) -> Any:
            async def call() -> None:
                with pytest.raises(dspy.LMError) as error:
                    await plain().acall(object())
                assert error.value.code == 'unsupported'
            await asyncio.create_task(call(), context=contextvars.Context())
            return dspy.Prediction(answer='ok')
    seen: list[Any] = []
    transport_for([], seen)
    assert asyncio.run(Executor(Unattributed()).run({}, 'c', 5)) == {'answer': 'ok'}
    assert seen == []


@pytest.mark.parametrize('ending', ['success', 'failure', 'cancelled'])
def test_standalone_plain_lm_works_after_run_cleanup(ending: str) -> None:
    class Ending(dspy.Module):
        async def aforward(self) -> Any:
            if ending == 'failure':
                raise ValueError('private author error')
            if ending == 'cancelled':
                raise asyncio.CancelledError()
            return dspy.Prediction(answer='ok')
    executor = Executor(Ending())
    if ending == 'success':
        assert asyncio.run(executor.run({}, 'c', 5)) == {'answer': 'ok'}
    else:
        with pytest.raises(GalaxieError):
            asyncio.run(executor.run({}, 'c', 5))
    assert integration._active_runs == 0
    with dspy.context(disable_history=True):
        assert plain()('q') == ['standalone']
        assert asyncio.run(plain().acall('q')) == ['standalone']


def test_routed_lm_remains_available_inside_run() -> None:
    predict = dspy.Predict('question -> answer')
    predict.set_lm(GalaxieLM('answer'))
    seen: list[Any] = []
    transport_for([{'content': fields(answer='ok')}], seen)
    assert asyncio.run(Executor(predict).run({'question': 'q'}, 'c', 5)) == {'answer': 'ok'}
    assert len(seen) == 1


def test_reload_preserves_one_guard_layer_and_async_entry() -> None:
    # Reload in another interpreter so existing imported GalaxieLM classes stay valid.
    result = subprocess.run([sys.executable, '-I', '-c', '''
import importlib
import inspect
import dspy
import galaxie.dspy as integration
sync, asynchronous = dspy.BaseLM.__call__, dspy.BaseLM.acall
importlib.reload(integration)
assert dspy.BaseLM.__call__ is sync
assert dspy.BaseLM.acall is asynchronous
assert inspect.iscoroutinefunction(asynchronous)
assert sync.__wrapped__.__module__ == 'dspy.clients.base_lm'
assert asynchronous.__wrapped__.__module__ == 'dspy.clients.base_lm'
'''], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
