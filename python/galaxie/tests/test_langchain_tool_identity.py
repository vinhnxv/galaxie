# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Execution-lifetime and failure-precedence contract for the test candidate."""

import asyncio
import sys
from pathlib import Path

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.errors import GraphRecursionError

from galaxie import GalaxieError
from galaxie._bridge import ERROR_MESSAGES
from test_langchain_tool_calls import SCHEMA, transport_for

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests/conformance/cases-python'))
from tool_scope import Scope, ScopedGraph, check, current, execution
from tool_scoped_candidate import ScopedToolCandidate, scoped_capability_tool


def helper():
    return scoped_capability_tool('read', 'read@1', SCHEMA, 'Read a value.')


def bound():
    return ScopedToolCandidate(role='answer').bind_tools([helper()])


def test_first_failure_wins_and_unknown_codes_normalize_without_content():
    scope = Scope(1)
    scope.latch('timeout')
    scope.latch('unavailable')
    assert scope.failure == 'timeout'
    unknown = Scope(2)
    unknown.latch('PRIVATE-MARKER-unknown')
    assert unknown.failure == 'invalid'
    assert set(Scope.__slots__) == {'id', 'failure'}
    assert scope.failure in ERROR_MESSAGES
    assert 'PRIVATE-MARKER' not in repr(unknown)


@pytest.mark.parametrize('code', ['denied', 'unavailable'])
def test_helper_denial_is_text_and_other_failure_is_latched(code):
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': code}})

    async def exercise():
        with execution() as scope:
            if code == 'denied':
                assert await helper().ainvoke({'value': 2}) == 'Policy denied the request.'
                assert scope.failure is None
            else:
                with pytest.raises(GalaxieError) as error:
                    await helper().ainvoke({'value': 2})
                assert error.value.code == code
                assert scope.failure == code

    if code == 'denied':
        asyncio.run(exercise())
    else:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(exercise())
        assert error.value.code == code
    assert [message['op'] for message in seen] == ['capability']


@pytest.mark.parametrize('entry', ['model', 'tool', 'history'])
def test_latch_precedes_validation_and_blocks_every_later_request(entry):
    seen = transport_for(lambda _: pytest.fail('Request after latch.'))

    async def exercise():
        with execution() as scope:
            scope.latch('timeout')
            if entry == 'tool':
                await helper().ainvoke({'value': 2})
            else:
                messages = ([ToolMessage('PRIVATE-MARKER', tool_call_id='orphan', status='error')]
                            if entry == 'history' else [HumanMessage('request')])
                await bound().ainvoke(messages)

    with pytest.raises(GalaxieError) as error:
        asyncio.run(exercise())
    assert error.value.code == 'timeout'
    assert 'PRIVATE-MARKER' not in str(error.value)
    assert seen == []


@pytest.mark.parametrize('entry', ['model', 'tool'])
def test_missing_scope_fails_closed_before_transport(entry):
    seen = transport_for(lambda _: pytest.fail('Unscoped request.'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(helper().ainvoke({'value': 2}) if entry == 'tool'
                    else bound().ainvoke([HumanMessage('request')]))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('later', [None, 'invalid', 'timeout', 'recursion', 'cancelled', 'ordinary'])
def test_end_rule_preserves_original_code_and_non_bridge_exception_identity(later):
    exceptions = {
        'invalid': GalaxieError('invalid'), 'timeout': GalaxieError('timeout'),
        'recursion': GraphRecursionError('fixed recursion failure'),
        'cancelled': asyncio.CancelledError(), 'ordinary': RuntimeError('fixed author failure'),
    }
    original = exceptions.get(later)
    with pytest.raises(BaseException) as error:
        with execution() as scope:
            scope.latch('timeout')
            if original is not None:
                raise original
    if later in (None, 'invalid'):
        assert isinstance(error.value, GalaxieError)
        assert error.value.code == 'timeout'
    else:
        assert error.value is original
    assert current.get() is None


def test_no_latch_leaves_success_and_exceptions_unchanged():
    with execution():
        assert check().failure is None
    original = GalaxieError('denied')
    with pytest.raises(GalaxieError) as error:
        with execution():
            raise original
    assert error.value is original


def test_closed_scope_fails_in_a_copied_child_context():
    async def exercise():
        ready, finish = asyncio.Event(), asyncio.Event()

        async def child():
            ready.set()
            await finish.wait()
            with pytest.raises(GalaxieError) as error:
                check()
            assert error.value.code == 'unsupported'

        with execution():
            task = asyncio.create_task(child())
            await ready.wait()
        finish.set()
        await task
        assert current.get() is None

    asyncio.run(exercise())


def test_streaming_is_fixed_unsupported_and_error_history_still_refuses():
    seen = transport_for(lambda _: pytest.fail('Refused request.'))

    async def exercise(stream):
        with execution():
            if stream:
                async for _ in bound().astream([HumanMessage('request')]):
                    pass
            else:
                await bound().ainvoke([ToolMessage('private', tool_call_id='missing', status='error')])

    for stream in (False, True):
        with pytest.raises(GalaxieError) as error:
            asyncio.run(exercise(stream))
        assert error.value.code == 'unsupported'
    assert seen == []


def test_graph_wrapper_delegates_attributes_and_closes_on_early_aclose():
    class Graph:
        checkpointer = object()
        config = {'recursion_limit': 3}
        output_channels = ['messages']

        async def aget_state(self, config):
            return config

        async def astream(self, *args, **kwargs):
            yield check().id
            yield check().id

    async def exercise():
        graph = Graph()
        wrapped = ScopedGraph(graph)
        assert wrapped.checkpointer is graph.checkpointer
        assert wrapped.config is graph.config
        assert wrapped.output_channels is graph.output_channels
        assert await wrapped.aget_state({'value': 1}) == {'value': 1}
        stream = wrapped.astream(None)
        first = await anext(stream)
        await stream.aclose()
        assert current.get() is None
        assert [item async for item in wrapped.astream(None)] == [first + 1, first + 1]

    asyncio.run(exercise())
