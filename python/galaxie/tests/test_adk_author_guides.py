# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Execute the author-guide snippets with scripted CPython transports."""

import asyncio
import copy
import json

import pytest

from galaxie import _bridge
from galaxie import adk as face

# guide:begin input-agent-py
from google.adk.agents import LlmAgent

from galaxie import GalaxieError
from galaxie.adk import Executor, capability_tool, llm


def interaction(requests):
    return {
        'surfaceId': 'main',
        'viewRevision': 'r1',
        'component': 'app.CityQuestion/v1',
        'props': {'requests': requests},
    }


def resume(requests, action, payload):
    if (action != 'submit' or type(payload) is not dict
            or set(payload) != {'city'} or type(payload['city']) is not str
            or not payload['city']):
        raise GalaxieError('invalid')
    return [{'response': payload} for _ in requests]


def create():
    question = capability_tool(
        'ask_city', 'question.ask@1',
        {'type': 'object', 'properties': {'message': {'type': 'string'}},
         'required': ['message']},
        'Ask for a city.', long_running=True,
    )
    agent = LlmAgent(name='root', model=llm('answer'), tools=[question])
    return Executor(agent, interaction=interaction, resume=resume)
# guide:end input-agent-py


# guide:begin model-string-py
from google.adk.agents import LlmAgent

from galaxie.adk import Executor


def create_model():
    # The host must declare the answer role in the agent definition.
    return Executor(LlmAgent(name='root', model='answer'))
# guide:end model-string-py


# guide:begin toolset-py
from google.adk.agents import LlmAgent

from galaxie.adk import Executor, capability_tool, llm, toolset

TOOL_SPECS = (
    ('double', 'math.double@1', 'Double an integer.'),
    ('square', 'math.square@1', 'Square an integer.'),
)
VALUE_PARAMETERS = {
    'type': 'object', 'properties': {'value': {'type': 'integer'}},
    'required': ['value'],
}


def create_toolset():
    tools = [capability_tool(name, capability, VALUE_PARAMETERS, description)
             for name, capability, description in TOOL_SPECS]
    agent = LlmAgent(name='root', model=llm('answer'), tools=[toolset(tools)])
    return Executor(agent)
# guide:end toolset-py


# guide:begin planner-before-py
from google.adk.agents import LlmAgent
from google.adk.planners import PlanReActPlanner

from galaxie.adk import Executor, llm


def create_planner():
    # Refused by galaxie at preparation, before a model request.
    agent = LlmAgent(name='root', model=llm('answer'), planner=PlanReActPlanner())
    return Executor(agent)
# guide:end planner-before-py


def install(replies, seen):
    replies = iter(replies)

    async def transport(raw):
        message = json.loads(raw)
        seen.append((message['op'], message['payload']))
        return json.dumps({**message, 'kind': 'response', 'ok': True,
                           'payload': next(replies)})

    _bridge.install_transport(transport)


def tool_call(name, args):
    return {'id': 'call', 'type': 'function', 'function': {
        'name': name, 'arguments': json.dumps(args, separators=(',', ':')),
    }}


def run(executor):
    return asyncio.run(executor.run({'prompt': 'question'}, 's', 5))


def answer(executor, pending, payload):
    return asyncio.run(executor.run(None, 's', 5, resume={
        'interactionId': pending['id'], 'action': 'submit', 'payload': payload,
    }))


@pytest.mark.parametrize('reload', [False, True])
def test_input_snippet_validates_answers_and_restores_the_pending_question(reload):
    question = {'message': 'Which city?'}
    requests = [{'kind': 'long-running', 'tool': 'ask_city', 'args': question}]
    seen = []
    install([
        {'content': '', 'toolCalls': [tool_call('ask_city', question)]},
        {'pending': True}, {'content': 'finished'},
    ], seen)
    executor = create()
    executor.durable = True
    assert run(executor) is None
    pending = executor.pending('s')
    assert pending is not None
    assert pending['value'] == interaction(requests)
    assert [op for op, _ in seen] == ['model', 'capability']
    assert seen[1][1]['input'] == question
    if reload:
        checkpoint, metadata = executor._snapshot('s', 'bound')
        del executor
        executor = create()
        executor.durable = True
        assert asyncio.run(executor._restore(checkpoint, metadata, 'bound')) == 's'
        assert executor.pending('s') == pending
    before = copy.deepcopy(seen)
    for payload in ({}, {'city': 1}, {'city': ''}, {'city': 'Hue', 'extra': True}):
        with pytest.raises(GalaxieError) as error:
            answer(executor, pending, payload)
        assert error.value.code == 'invalid'
        assert executor.pending('s') == pending
        assert seen == before
    assert answer(executor, pending, {'city': 'Hue'}) == 'finished'
    assert executor.pending('s') is None
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
    assert seen[-1][1]['messages'][-1] == {
        'role': 'tool', 'tool_call_id': 'galaxie-1', 'content': '{"city":"Hue"}',
    }


def test_declared_model_string_snippet_routes_exactly_one_answer_request(monkeypatch):
    monkeypatch.setattr(face, '_roles', frozenset({'answer'}))
    seen = []
    install([{'content': 'done'}], seen)
    executor = create_model()
    assert run(executor) == 'done'
    assert [op for op, _ in seen] == ['model']
    assert seen[0][1]['role'] == 'answer'


@pytest.mark.parametrize('role,declared', [
    ('answer', frozenset()),
    ('gemini-2.5-flash', frozenset({'gemini-2.5-flash'})),
])
def test_undeclared_and_gemini_named_strings_refuse_without_requests(monkeypatch, role, declared):
    monkeypatch.setattr(face, '_roles', declared)
    seen = []
    install([], seen)
    agent = LlmAgent(name='root', model=role)
    with pytest.raises(GalaxieError) as error:
        Executor(agent)
    assert error.value.code == 'unsupported'
    assert agent.model == role
    assert seen == []


def test_fixed_toolset_snippet_preserves_flat_declarations_and_one_capability_call():
    observations = []
    for grouped in (False, True):
        seen = []
        install([
            {'content': '', 'toolCalls': [tool_call('double', {'value': 21})]},
            {'value': 42}, {'content': 'done'},
        ], seen)
        if grouped:
            executor = create_toolset()
        else:
            tools = [capability_tool(name, capability, VALUE_PARAMETERS, description)
                     for name, capability, description in TOOL_SPECS]
            executor = Executor(LlmAgent(name='root', model=llm('answer'), tools=[*tools]))
        assert run(executor) == 'done'
        assert [op for op, _ in seen] == ['model', 'capability', 'model']
        assert seen[1][1]['name'] == 'math.double@1'
        assert seen[1][1]['input'] == {'value': 21}
        declarations = [payload['options']['tools'] for op, payload in seen if op == 'model']
        assert [tool['function']['name'] for tool in declarations[0]] == ['double', 'square']
        observations.append(declarations)
    assert observations[0] == observations[1]


def test_plan_react_snippet_is_refused_and_the_same_script_retains_tags_without_it():
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    seen = []
    install([], seen)
    with pytest.raises(GalaxieError) as error:
        create_planner()
    assert error.value.code == 'unsupported'
    assert seen == []
    reply = '/*PLANNING*/think/*FINAL_ANSWER*/done'
    install([{'content': reply}], seen)
    assert run(Executor(LlmAgent(name='root', model=llm('answer')))) == reply
    assert [op for op, _ in seen] == ['model']
    native_requests = []

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            native_requests.append(llm_request)
            yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text=reply)]),
                              turn_complete=True)

    async def native():
        agent = LlmAgent(name='root', model=Scripted(model='scripted'), planner=PlanReActPlanner())
        runner = InMemoryRunner(agent=agent, app_name='guide')
        await runner.session_service.create_session(app_name='guide', user_id='user', session_id='s')
        try:
            return [event async for event in runner.run_async(
                user_id='user', session_id='s',
                new_message=types.Content(role='user', parts=[types.Part(text='question')]),
            )]
        finally:
            await runner.close()

    events = asyncio.run(native())
    assert len(native_requests) == 1
    assert any(part.thought and part.text == 'think' for event in events if event.content
               for part in event.content.parts or [])
    final = ''.join(part.text or '' for event in events if event.is_final_response() and event.content
                    for part in event.content.parts or [] if not part.thought)
    assert final == 'done'
