# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Independent, scripted facts about the pinned native AgentTool."""

import asyncio
from collections import Counter

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import AgentTool, FunctionTool
from google.genai import types


def observe(*, output_key='changed', twice=False, failure=None, pause=None):
    """Run native ADK without galaxie models, tools or session services."""
    requests = []
    states = []
    turns = Counter()
    calls = 2 if twice else 1

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            requests.append((self.model, llm_request.model_copy(deep=True)))
            turns[self.model] += 1
            if self.model == 'inner' and failure == 'cancel':
                raise asyncio.CancelledError()
            if self.model == 'inner' and failure == 'event':
                yield LlmResponse(error_code='SCRIPTED', error_message='scripted failure')
                return
            if self.model == 'inner' and pause and turns[self.model] == 1:
                yield LlmResponse(content=types.Content(role='model', parts=[types.Part(
                    function_call=types.FunctionCall(name='wait', args={'request': 'question'}),
                )]))
                return
            if self.model == 'outer' and turns[self.model] == 1:
                content = types.Content(role='model', parts=[types.Part(function_call=types.FunctionCall(
                    id=f'call-{index}', name='inner', args={'request': f'question-{index}'},
                )) for index in range(calls)])
            else:
                content = types.Content(role='model', parts=[types.Part(text=f'{self.model} answer')])
            yield LlmResponse(content=content, turn_complete=True)

    def before(callback_context):
        states.append(dict(callback_context.state.to_dict()))

    def wait(request: str, tool_context) -> dict:
        if pause == 'confirmation':
            tool_context.request_confirmation()
        return {'waiting': True}

    from google.adk.tools import LongRunningFunctionTool
    tools = ([LongRunningFunctionTool(wait)] if pause == 'long-running' else [FunctionTool(wait)]) if pause else []
    inner = LlmAgent(name='inner', description='Answer one question.', model=Scripted(model='inner'),
                     before_agent_callback=before, output_key=output_key, tools=tools)
    wrapper = AgentTool(inner)
    outer = LlmAgent(name='outer', model=Scripted(model='outer'), tools=[wrapper])

    async def run():
        sessions = InMemorySessionService()
        session = await sessions.create_session(app_name='native', user_id='user', session_id='s',
                                               state={'ordinary': 'copied', 'temp:input': 'temporary', '_adk:private': 'hidden'})
        runner = Runner(app_name='native', agent=outer, session_service=sessions)
        events = [event async for event in runner.run_async(user_id='user', session_id=session.id,
                  new_message=types.Content(role='user', parts=[types.Part(text='go')]))]
        saved = await sessions.get_session(app_name='native', user_id='user', session_id='s')
        await runner.close()
        return events, saved

    events, saved = asyncio.run(run())
    return wrapper, requests, states, events, saved


def test_native_declaration_order_result_state_and_isolation():
    wrapper, requests, states, events, saved = observe()
    declaration = wrapper._get_declaration()
    assert declaration.name == 'inner'
    assert declaration.description == 'Answer one question.'
    assert declaration.parameters_json_schema == {
        'type': 'object', 'properties': {'request': {'type': 'string'}}, 'required': ['request'],
    }
    assert wrapper.include_plugins is True
    assert [name for name, _ in requests] == ['outer', 'inner', 'outer']
    assert states == [{'ordinary': 'copied'}]
    responses = [part.function_response.response for event in events if event.content
                 for part in event.content.parts or [] if part.function_response]
    assert responses == [{'result': 'inner answer'}]
    assert saved.state['changed'] == 'inner answer'
    assert {event.author for event in events} == {'outer'}


def test_native_temporary_output_delta_is_not_forwarded_to_the_outer_turn():
    _, requests, states, events, saved = observe(output_key='temp:changed')
    # Capture the native event boundary, independently of persistence's temp filtering.
    responses = [event for event in events if event.content and any(
        part.function_response for part in event.content.parts or [])]
    assert len(responses) == 1
    assert responses[0].actions.state_delta == {}
    assert 'temp:changed' not in saved.state
    assert states == [{'ordinary': 'copied'}]
    assert [name for name, _ in requests] == ['outer', 'inner', 'outer']


def test_native_two_calls_use_independent_inner_sessions():
    _, requests, states, _, _ = observe(twice=True)
    assert [name for name, _ in requests] == ['outer', 'inner', 'inner', 'outer']
    assert states == [{'ordinary': 'copied'}, {'ordinary': 'copied'}]


def test_native_error_event_becomes_model_visible_tool_text():
    _, requests, _, events, _ = observe(failure='event')
    assert [name for name, _ in requests] == ['outer', 'inner', 'outer']
    assert any(part.function_response and part.function_response.response == {'result': 'scripted failure'}
               for event in events if event.content for part in event.content.parts or [])


def test_native_inner_cancellation_is_consumed_by_the_node_runtime():
    _, requests, _, events, _ = observe(failure='cancel')
    assert [name for name, _ in requests] == ['outer', 'inner', 'outer']
    assert any(part.function_response and part.function_response.response == {'result': ''}
               for event in events if event.content for part in event.content.parts or [])


@pytest.mark.parametrize('pause', ['confirmation', 'long-running'])
def test_native_nested_pause_returns_without_resumable_inner_events(pause):
    _, requests, _, events, _ = observe(pause=pause)
    assert [name for name, _ in requests] in (['outer', 'inner', 'outer'], ['outer', 'inner', 'inner', 'outer'])
    assert {event.author for event in events} == {'outer'}
    assert not any(event.long_running_tool_ids for event in events)
