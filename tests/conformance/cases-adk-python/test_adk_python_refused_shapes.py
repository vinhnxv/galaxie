# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""What native ADK 2.12.0 does with the shapes the adk-python executor refuses (ADR-0022 decision 12).

These tests use ADK's own Runner and scripted models, no galaxie code. The refusals live in
`galaxie.adk` and are asserted in the Worker lane; here only the native result is recorded, so a
refusal can be checked against the behavior it stands for.
"""

import asyncio

from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.adk.tools.agent_tool import AgentTool
from google.adk.workflow import Workflow
from google.genai import types

CONFIRMATION = 'adk_request_confirmation'


# The agents that called their model, in order; pydantic copies list fields, so the log is module state.
LOG: list[str] = []


class Scripted(BaseLlm):
    """Answers with the next scripted reply, a text or a (tool name, arguments) pair, and logs the agent."""

    replies: list

    async def generate_content_async(self, llm_request, stream=False):
        reply = self.replies.pop(0)
        LOG.append(self.model)
        if isinstance(reply, str):
            parts = [types.Part(text=reply)]
        else:
            parts = [types.Part(function_call=types.FunctionCall(name=reply[0], args=reply[1]))]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


def double(value: int) -> dict:
    """Double an integer."""
    return {'value': value * 2}


def leaf(name, replies, gated=False, **options):
    return LlmAgent(
        name=name, model=Scripted(model=name, replies=list(replies)), instruction='Answer.',
        tools=[FunctionTool(double, require_confirmation=True)] if gated else [], **options,
    )


async def converse(root):
    """Run to the end, approving every confirmation; returns the final texts and the agents that ran."""
    runner = InMemoryRunner(agent=root, app_name='shapes')
    await runner.session_service.create_session(app_name='shapes', user_id='user', session_id='session')
    message = types.Content(role='user', parts=[types.Part(text='go')])
    finals = []
    for _ in range(3):
        asks = []
        async for event in runner.run_async(user_id='user', session_id='session', new_message=message):
            parts = (event.content.parts or []) if event.content else []
            asks += [part.function_call.id for part in parts if part.function_call and part.function_call.name == CONFIRMATION]
            if event.is_final_response() and event.content and not asks:
                finals.append((event.author, ''.join(part.text or '' for part in parts)))
        if not asks:
            break
        message = types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
            id=identifier, name=CONFIRMATION, response={'confirmed': True},
        )) for identifier in asks])
    return finals


def gated(name):
    return leaf(name, [('double', {'value': 2}), f'{name} done'], gated=True)


def test_the_last_child_of_a_sequential_agent_resumes_and_finishes():
    LOG.clear()
    root = SequentialAgent(name='pipeline', sub_agents=[leaf('first', ['first done']), gated('second')])
    assert asyncio.run(converse(root)) == [('first', 'first done'), ('second', 'second done')]
    assert LOG == ['first', 'second', 'second']


def test_a_sequential_agent_never_runs_the_successors_of_a_child_that_paused():
    LOG.clear()
    root = SequentialAgent(name='pipeline', sub_agents=[gated('first'), leaf('second', ['second done'])])
    assert asyncio.run(converse(root)) == [('first', 'first done')]
    assert 'second' not in LOG


def test_a_loop_agent_never_starts_the_next_iteration_after_a_pause():
    LOG.clear()
    worker = leaf('worker', [('double', {'value': 2}), 'pass one', ('double', {'value': 3}), 'pass two'], gated=True)
    root = LoopAgent(name='refine', max_iterations=2, sub_agents=[worker])
    assert asyncio.run(converse(root)) == [('worker', 'pass one')]
    assert LOG == ['worker', 'worker']


def test_a_parallel_agent_resumes_only_the_branch_that_paused_and_nothing_after_it():
    LOG.clear()
    fanout = ParallelAgent(name='fanout', sub_agents=[gated('left'), leaf('right', ['right done'])])
    root = SequentialAgent(name='pipeline', sub_agents=[fanout, leaf('merger', ['merged'])])
    # The sibling branch finished before the pause; after the answer only the paused branch continues.
    assert asyncio.run(converse(root)) == [('right', 'right done'), ('left', 'left done')]
    assert LOG.count('right') == 1
    assert 'merger' not in LOG


def test_a_transfer_target_resumes_in_place_which_the_executor_refuses_conservatively():
    LOG.clear()
    specialist = gated('specialist')
    router = LlmAgent(
        name='router', model=Scripted(model='router', replies=[('transfer_to_agent', {'agent_name': 'specialist'})]),
        instruction='Route.', sub_agents=[specialist],
    )
    assert asyncio.run(converse(router)) == [('specialist', 'specialist done')]
    assert LOG == ['router', 'specialist', 'specialist']


def test_agent_tool_and_workflow_run_natively_but_are_refused_by_the_executor():
    LOG.clear()
    worker = leaf('worker', ['worker says hi'])
    root = LlmAgent(
        name='root', model=Scripted(model='root', replies=[('worker', {'request': 'hi'}), 'root done']),
        instruction='Delegate.', tools=[AgentTool(agent=worker)],
    )
    assert asyncio.run(converse(root)) == [('root', 'root done')]
    assert LOG == ['root', 'worker', 'root']

    async def workflow():
        flow = Workflow(name='flow', edges=[('START', leaf('step', ['step done']))])
        runner = InMemoryRunner(node=flow, app_name='flow')
        await runner.session_service.create_session(app_name='flow', user_id='user', session_id='session')
        texts = []
        async for event in runner.run_async(
            user_id='user', session_id='session', new_message=types.Content(role='user', parts=[types.Part(text='go')]),
        ):
            if event.is_final_response() and event.content:
                texts.append(''.join(part.text or '' for part in event.content.parts or []))
        return texts

    assert asyncio.run(workflow()) == ['step done']
