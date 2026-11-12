# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Python measurement against the unchanged executor.

T-py ALTERNATIVE: GT1/GT2 pass in a test-local fixed-list expansion; GT3 passes
for confirmations and Loop refusal. GT4 uses closed membership. GT5 fails: no
public registered-toolset constructor. AL-T passes for a static list only.
N-py REFUSED: GN1 fails (provider tools refused, not carried); GN2 not measured after GN1;
GN3 passes. AL-N fails: native search emits no function call to replace.
X-py REFUSED: GX1 fails (author file access in native probe; Worker subprocess
source absence). GX2 not measured after GX1; GX3 passes. No AL-X boundary.
L-py REFUSED: GL1 fails (thinking dropped; tagged final differs); GL2 not measured
after GL1; GL3 passes. AL-L fails under the same tagged script.
"""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent, LoopAgent
from google.adk.code_executors import BuiltInCodeExecutor, UnsafeLocalCodeExecutor
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.planners import BuiltInPlanner, PlanReActPlanner
from google.adk.tools import FunctionTool, google_search
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.enterprise_search_tool import EnterpriseWebSearchTool
from google.adk.tools.google_maps_grounding_tool import google_maps_grounding
from google.adk.tools.load_web_page import load_web_page
from google.adk.tools.openapi_tool.openapi_spec_parser.openapi_toolset import OpenAPIToolset
from google.adk.tools.url_context_tool import url_context
from google.adk.tools.vertex_ai_search_tool import VertexAiSearchTool
from google.genai import types

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, capability_tool, llm

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


def install(replies, seen):
    replies = iter(replies)

    async def transport(raw):
        message = json.loads(raw)
        seen.append((message['op'], message['payload']))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': next(replies)})
    _bridge.install_transport(transport)


def tool(gated=False):
    return capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.', require_confirmation=gated)


def root(tools=(), **options):
    return LlmAgent(name='root', model=llm('answer'), instruction='Use the tools.', tools=list(tools), **options)


class StaticTools(BaseToolset):
    def __init__(self, tools, **options):
        super().__init__(**options)
        self.fixed = tuple(tools)

    async def get_tools(self, readonly_context=None):
        return list(self.fixed)


def expand(candidate):
    """Test-local registration and fixed expansion; no helper ships."""
    if type(candidate) is not StaticTools or candidate not in face._tools or candidate.tool_filter is not None:
        raise GalaxieError('unsupported')
    if any(type(item) is not face._CapabilityTool or item not in face._tools for item in candidate.fixed):
        raise GalaxieError('unsupported')
    return list(candidate.fixed)


def interact(requests):
    return {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'app.Approval/v1', 'props': {'requests': requests}}


def test_fixed_expansion_and_flat_list_have_equal_requests_confirmation_and_write_scope():
    observations = []
    for grouped in (False, True):
        seen = []
        install([
            {'content': '', 'toolCalls': [{'id': 'call', 'type': 'function', 'function': {
                'name': 'double', 'arguments': '{"value":21}'}}]},
            {'value': 42}, {'content': 'done'},
        ], seen)
        capability = tool(gated=True)
        group = StaticTools([capability])
        saved = dict(face._tools._refs)
        try:
            face._tools.add(group)
            tools = expand(group) if grouped else [capability]
            executor = Executor(root(tools), interaction=interact)
            assert asyncio.run(executor.run({'prompt': 'question'}, 's', 5)) is None
            assert [op for op, _ in seen] == ['model']
            pending = executor.pending('s')
            assert pending is not None
            assert asyncio.run(executor.run(None, 's', 5, resume={
                'interactionId': pending['id'], 'action': 'approve', 'payload': {'indexes': [0]},
            })) == 'done'
            assert [op for op, _ in seen] == ['model', 'capability', 'model']
            assert seen[1][1]['effectScope'] == 'adk-python/s/root/0/0'
            observations.append((seen, pending))
            with pytest.raises(GalaxieError) as error:
                Executor(LoopAgent(name='loop', max_iterations=2, sub_agents=[root(expand(group))]), interaction=interact)
            assert error.value.code == 'unsupported'
        finally:
            face._tools._refs.clear()
            face._tools._refs.update(saved)
    assert observations[0] == observations[1]


@pytest.mark.parametrize('kind', ['unregistered', 'filter', 'foreign', 'nested', 'throwing'])
def test_candidate_neighbours_fail_before_requests(kind):
    class Throwing(StaticTools):
        async def get_tools(self, readonly_context=None):
            raise AssertionError('Toolset body must not run.')

    group = Throwing([tool()]) if kind == 'throwing' else StaticTools(
        [FunctionTool(load_web_page)] if kind == 'foreign' else [StaticTools([tool()])] if kind == 'nested' else [tool()],
        tool_filter=(lambda *_: True) if kind == 'filter' else None)
    saved = dict(face._tools._refs)
    seen = []
    install([], seen)
    try:
        if kind != 'unregistered':
            face._tools.add(group)
        with pytest.raises(GalaxieError) as error:
            expand(group)
        assert error.value.code == 'unsupported'
        assert seen == []
    finally:
        face._tools._refs.clear()
        face._tools._refs.update(saved)


@pytest.mark.parametrize('factory', [
    lambda: google_search, lambda: url_context,
    lambda: VertexAiSearchTool(data_store_id='projects/test/locations/global/collections/default_collection/dataStores/test'),
    lambda: google_maps_grounding, EnterpriseWebSearchTool,
    lambda: FunctionTool(load_web_page), lambda: StaticTools([tool()]),
    lambda: object.__new__(OpenAPIToolset),
])
@pytest.mark.parametrize('role', ['answer', 'gemini-2.5-flash'])
def test_builtins_and_toolsets_are_refused_even_for_a_gemini_named_role(factory, role):
    seen = []
    install([], seen)
    agent = root([factory()])
    agent.model = llm(role)
    with pytest.raises(GalaxieError) as error:
        Executor(agent)
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('options', [
    {'code_executor': BuiltInCodeExecutor()}, {'code_executor': UnsafeLocalCodeExecutor()},
    {'planner': BuiltInPlanner(thinking_config=types.ThinkingConfig(thinking_budget=128))},
    {'planner': PlanReActPlanner()},
])
def test_executor_and_planner_families_refuse_without_requests(options):
    seen = []
    install([], seen)
    with pytest.raises(GalaxieError) as error:
        Executor(root(**options))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_an_author_network_function_is_refused_without_executing_its_body():
    calls = []

    def fetch_page(url: str) -> str:
        calls.append(url)
        raise AssertionError('Network body must not run.')

    seen = []
    install([], seen)
    with pytest.raises(GalaxieError) as error:
        Executor(root([FunctionTool(fetch_page)]))
    assert error.value.code == 'unsupported'
    assert seen == calls == []


def test_provider_config_is_absent_from_the_router_payload():
    async def measure(config):
        seen = []
        install([{'content': 'done'}], seen)
        token = face._active.set(face._Run(steps=5, conversation='s', seeded=0))
        try:
            request = LlmRequest(model='gemini-2.5-flash', config=config,
                                 contents=[types.Content(role='user', parts=[types.Part(text='question')])])
            if config.tools:
                with pytest.raises(GalaxieError) as error:
                    _ = [reply async for reply in llm('answer').generate_content_async(request)]
                assert error.value.code == 'unsupported'
                assert seen == []
                return seen
            responses = [reply async for reply in llm('answer').generate_content_async(request)]
            assert responses[0].content is not None and responses[0].content.parts
            assert responses[0].content.parts[0].text == 'done'
            return seen
        finally:
            face._active.reset(token)

    plain = asyncio.run(measure(types.GenerateContentConfig()))
    provider = asyncio.run(measure(types.GenerateContentConfig(tools=[types.Tool(google_search=types.GoogleSearch())])))
    thinking = asyncio.run(measure(types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=128))))
    assert provider == []  # Contrary to the silent-drop prediction: the backstop refuses.
    assert plain == thinking
    assert [op for op, _ in plain] == ['model']
    assert plain[0][1]['options'] == {}


def test_instruction_only_replacement_cannot_remove_plan_react_tags():
    reply = '/*PLANNING*/think/*FINAL_ANSWER*/done'
    seen = []
    install([{'content': reply}], seen)
    agent = root()
    agent.instruction = 'Use the tools. Plan, then answer.'
    assert asyncio.run(Executor(agent).run({'prompt': 'question'}, 's', 5)) == reply
    assert reply != 'done'  # Native PlanReAct final in the independent native evidence.


def test_flat_capability_list_matches_the_native_static_toolset_script():
    native_requests = []
    calls = []

    def double(value: int) -> dict:
        """Double an integer."""
        calls.append(value)
        return {'value': value * 2}

    class Scripted(BaseLlm):
        turn: int = 0

        async def generate_content_async(self, llm_request, stream=False):
            native_requests.append(face._tool_definitions(llm_request))
            self.turn += 1
            parts = [types.Part(function_call=types.FunctionCall(name='double', args={'value': 21}))] if self.turn == 1 else [types.Part(text='done')]
            yield LlmResponse(content=types.Content(role='model', parts=parts))

    async def native():
        runner = InMemoryRunner(agent=LlmAgent(name='root', model=Scripted(model='scripted'),
                                              tools=[StaticTools([FunctionTool(double)])]), app_name='spike')
        await runner.session_service.create_session(app_name='spike', user_id='user', session_id='s')
        try:
            events = [event async for event in runner.run_async(user_id='user', session_id='s',
                      new_message=types.Content(role='user', parts=[types.Part(text='question')]))]
            return ''.join(part.text or '' for event in events if event.is_final_response() and event.content
                           for part in event.content.parts or [] if not part.thought)
        finally:
            await runner.close()

    assert asyncio.run(native()) == 'done'
    assert calls == [21]
    seen = []
    install([{'content': '', 'toolCalls': [{'id': 'call', 'type': 'function', 'function': {
        'name': 'double', 'arguments': '{"value":21}'}}]}, {'value': 42}, {'content': 'done'}], seen)
    # Preserve the native tool's authored schema, including its annotation titles.
    native_schema = native_requests[0][0]['function']['parameters']
    replacement = capability_tool('double', 'math.double@1', native_schema, 'Double an integer.')
    assert asyncio.run(Executor(root([replacement])).run({'prompt': 'question'}, 's', 5)) == 'done'
    assert [payload['options']['tools'] for op, payload in seen if op == 'model'] == native_requests
    assert [payload['input']['value'] for op, payload in seen if op == 'capability'] == calls
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
