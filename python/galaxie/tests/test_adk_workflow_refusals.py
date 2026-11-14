# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Excluded native graph constructs fail before the adapter dispatches anything."""

import pytest
from google.adk.agents import BaseAgent, LlmAgent
from google.adk.agents.context import Context
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools import FunctionTool
from google.adk.workflow import FunctionNode, RetryConfig, Workflow
from google.genai import types
from typing import cast

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, capability_tool, llm


def leaf(name='a', **options):
    return LlmAgent(name=name, model=llm(name), **options)


def excluded(kind):
    agent = leaf()
    if kind == 'author-function':
        return Workflow(name='wf', edges=[('START', FunctionNode(name='authored', func=lambda: 'authored'))])
    if kind == 'retry':
        agent.retry_config = RetryConfig(max_attempts=2, initial_delay=0, jitter=0)
    if kind == 'timeout':
        agent.timeout = 1
    if kind == 'rerun':
        agent.rerun_on_resume = True
    if kind == 'parallel-worker':
        agent.parallel_worker = True
    if kind == 'nested':
        return Workflow(name='wf', edges=[('START', Workflow(name='inner', edges=[('START', agent)]))])
    if kind == 'tool-node':
        def write(value: int) -> dict:
            return {'value': value}
        return Workflow(name='wf', edges=[('START', FunctionTool(write))])
    if kind == 'cycle':
        return Workflow(name='wf', edges=[('START', agent), (agent, {'again': agent})])
    if kind in ('confirmation', 'long-running'):
        agent.tools = [capability_tool('write', 'notes.write@1', {'type': 'object'}, 'Write.',
                       require_confirmation=kind == 'confirmation', long_running=kind == 'long-running')]
    if kind == 'model':
        agent.model = 'unregistered-model'
    if kind == 'repeated-name':
        other = leaf('b')
        flow = Workflow(name='wf', edges=[('START', agent, other)])
        # Native construction rejects duplicates; author mutation must not bypass prepare either.
        other.name = agent.name
        return flow
    if kind == 'subclass':
        class CustomWorkflow(Workflow):
            pass
        return CustomWorkflow(name='wf', edges=[('START', agent)])
    return Workflow(name='wf', edges=[('START', agent)])


@pytest.mark.parametrize('kind', [
    'author-function', 'retry', 'timeout', 'nested', 'tool-node', 'cycle', 'rerun',
    'parallel-worker', 'subclass', 'confirmation', 'long-running', 'model', 'repeated-name',
])
def test_excluded_workflow_constructs_fail_before_bridge_dispatch(kind):
    dispatched = []

    async def forbidden(raw):
        dispatched.append(raw)
        pytest.fail('prepare must not dispatch')

    _bridge.install_transport(forbidden)
    flow = excluded(kind)
    assert flow.graph is not None
    with pytest.raises(GalaxieError) as error:
        Executor(cast(BaseAgent, flow))
    assert error.value.code == 'unsupported'
    assert dispatched == []


def test_hidden_model_inside_an_author_function_is_never_invoked_by_prepare():
    calls = []

    class Hidden(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            calls.append(self.model)
            yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text='hidden')]))

    hidden = Hidden(model='unregistered-script')

    async def dispatch(ctx: Context):
        return [reply async for reply in hidden.generate_content_async(LlmRequest())]

    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')

    _bridge.install_transport(forbidden)
    flow = Workflow(name='wf', edges=[('START', FunctionNode(name='authored', func=dispatch))])
    with pytest.raises(GalaxieError) as error:
        Executor(cast(BaseAgent, flow))
    assert error.value.code == 'unsupported'
    assert calls == []


def test_native_graph_construction_also_rejects_two_distinct_nodes_with_one_name():
    with pytest.raises(ValueError, match='Duplicate node names'):
        Workflow(name='wf', edges=[('START', leaf(), leaf())])
