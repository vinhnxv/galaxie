# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native ADK 2.12.0 resumable workflow evidence, independent of galaxie.

Compare each resumed script with an uninterrupted run, including model dispatches
and actual tool executions. The non-resumable evidence stays in refused_shapes.
"""

import asyncio
from collections import Counter

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool, LongRunningFunctionTool
from google.genai import types

CONFIRMATION = 'adk_request_confirmation'
LOG: list[str] = []
TOOLS: list[int] = []


class Scripted(BaseLlm):
    replies: list

    async def generate_content_async(self, llm_request, stream=False):
        LOG.append(self.model)
        reply = self.replies.pop(0)
        part = types.Part(text=reply) if isinstance(reply, str) else types.Part(
            function_call=types.FunctionCall(name=reply[0], args=reply[1]),
        )
        yield LlmResponse(content=types.Content(role='model', parts=[part]), turn_complete=True)


def double(value: int) -> dict:
    """Double an integer."""
    TOOLS.append(value)
    return {'value': value * 2}


def pending_double(value: int) -> None:
    """Start doubling an integer; the caller supplies the eventual result."""
    TOOLS.append(value)


def leaf(name, replies=None, *, confirm=False, long_running=False):
    tools = [LongRunningFunctionTool(pending_double)] if long_running else [FunctionTool(double, require_confirmation=confirm)]
    return LlmAgent(
        name=name, model=Scripted(model=name, replies=list(replies or [f'{name} done'])),
        instruction='Answer.', tools=tools,
    )


def gated(name, confirm, value=2):
    return leaf(name, [('double', {'value': value}), f'{name} done'], confirm=confirm)


def tree(shape, confirm):
    if shape == 'first':
        return SequentialAgent(name='pipeline', sub_agents=[gated('first', confirm), leaf('second')])
    if shape == 'middle':
        return SequentialAgent(name='pipeline', sub_agents=[leaf('a'), gated('b', confirm), leaf('c')])
    if shape == 'sequence-writer':
        return SequentialAgent(name='pipeline', sub_agents=[gated('a', False, 10), gated('b', confirm), leaf('c')])
    if shape == 'nested':
        inner = SequentialAgent(name='inner_sequence', sub_agents=[gated('inner', confirm), leaf('b')])
        return SequentialAgent(name='pipeline', sub_agents=[inner, leaf('c')])
    if shape == 'loop':
        worker = leaf('worker', [
            ('double', {'value': 2}), 'pass one', ('double', {'value': 3}), 'pass two',
        ], confirm=confirm)
        return LoopAgent(name='refine', max_iterations=2, sub_agents=[worker])
    if shape == 'loop-writer':
        writer = leaf('writer', [('double', {'value': 10}), 'written', ('double', {'value': 20}), 'written'])
        checker = leaf('checker', [('double', {'value': 2}), 'checked', ('double', {'value': 3}), 'checked'], confirm=confirm)
        return LoopAgent(name='refine', max_iterations=2, sub_agents=[writer, checker])
    if shape == 'parallel':
        fanout = ParallelAgent(name='fanout', sub_agents=[gated('left', confirm), gated('right', False, 3)])
        return SequentialAgent(name='pipeline', sub_agents=[fanout, leaf('merger')])
    if shape == 'long-running':
        worker = leaf('b', [('pending_double' if confirm else 'double', {'value': 2}), 'b done'], long_running=confirm)
        return SequentialAgent(name='pipeline', sub_agents=[leaf('a'), worker, leaf('c')])
    raise AssertionError(shape)


async def converse(root):
    runner = InMemoryRunner(app=App(
        name='shapes', root_agent=root, resumability_config=ResumabilityConfig(is_resumable=True),
    ))
    await runner.session_service.create_session(app_name='shapes', user_id='user', session_id='session')
    message = types.Content(role='user', parts=[types.Part(text='go')])
    finals = []
    pauses = []
    for _ in range(5):
        asks = []
        async for event in runner.run_async(user_id='user', session_id='session', new_message=message):
            parts = event.content.parts or [] if event.content else []
            for part in parts:
                call = part.function_call
                if call and call.id in (event.long_running_tool_ids or set()):
                    asks.append((call.id, call.name))
            text = ''.join(part.text or '' for part in parts)
            if event.is_final_response() and text:
                finals.append((event.author, text))
        if not asks:
            return finals, pauses
        pauses.append(asks)
        message = types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
            id=identifier, name=name, response={'confirmed': True} if name == CONFIRMATION else {'value': 4},
        )) for identifier, name in asks])
    raise AssertionError('The resumable invocation did not finish')


@pytest.mark.parametrize(('shape', 'expected', 'tools', 'pauses'), [
    ('first', ['first', 'first', 'second'], [2], 1),
    ('middle', ['a', 'b', 'b', 'c'], [2], 1),
    ('sequence-writer', ['a', 'a', 'b', 'b', 'c'], [10, 2], 1),
    ('nested', ['inner', 'inner', 'b', 'c'], [2], 1),
    ('loop', ['worker'] * 4, [2, 3], 2),
    ('parallel', ['left', 'left', 'right', 'right', 'merger'], [2, 3], 1),
    ('long-running', ['a', 'b', 'b', 'c'], [2], 1),
])
def test_resumable_shape_matches_uninterrupted_dispatches_and_tools(shape, expected, tools, pauses):
    LOG.clear()
    TOOLS.clear()
    uninterrupted, no_pauses = asyncio.run(converse(tree(shape, False)))
    assert no_pauses == []
    baseline = Counter(LOG), Counter(TOOLS), sorted(uninterrupted)
    LOG.clear()
    TOOLS.clear()
    resumed, pending = asyncio.run(converse(tree(shape, True)))
    assert len(pending) == pauses
    assert (Counter(LOG), Counter(TOOLS), sorted(resumed)) == baseline
    assert Counter(LOG) == Counter(expected)
    assert Counter(TOOLS) == Counter(tools)
    if shape != 'parallel':
        assert LOG == expected
        assert TOOLS == tools


def test_loop_with_writer_repeats_a_finished_tool_and_stays_refused():
    """A bare looping worker passes, but the general loop shape fails the tool-once gate."""
    LOG.clear()
    TOOLS.clear()
    uninterrupted, _ = asyncio.run(converse(tree('loop-writer', False)))
    assert TOOLS == [10, 2, 20, 3]
    LOG.clear()
    TOOLS.clear()
    resumed, pauses = asyncio.run(converse(tree('loop-writer', True)))
    assert resumed == uninterrupted
    assert len(pauses) == 2
    assert LOG == ['writer', 'writer', 'checker', 'checker'] * 2
    assert Counter(TOOLS) == Counter([10, 10, 2, 20, 3])


def test_two_parallel_confirmations_are_native_but_remain_refused_by_the_single_pause_tracker():
    """ADK asks both branches but resumes only one; the other never finishes."""
    LOG.clear()
    TOOLS.clear()
    root = ParallelAgent(name='fanout', sub_agents=[gated('left', True), gated('right', True, 3)])
    finals, pauses = asyncio.run(converse(root))
    assert sorted(finals) == [('left', 'left done')]
    assert sum(map(len, pauses)) == 2
    assert Counter(LOG) == Counter({'left': 2, 'right': 1})
    assert TOOLS == [2]
