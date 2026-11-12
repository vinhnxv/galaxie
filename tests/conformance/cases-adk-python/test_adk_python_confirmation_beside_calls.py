# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native ADK 2.12.0 confirmation continuity, with scripted models only.

Gate | Observed | Result
NA1 | A1/A2/A3 approve and deny retain every result, each body once | PASS
NB1 | Both orders discard the external answer when combined with confirmation | FAIL
NB2 | Either split order delivers the answer, but calls the model between answers | informational
NC1 | LlmAgent receives the request-input answer | PASS

NB1 makes the mixed-pause adapter gates inapplicable: changing the tracker
cannot recover an answer ADK has already removed from the model request.
"""

import asyncio
import copy
from collections import Counter

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool, LongRunningFunctionTool
from google.adk.tools._request_input_tool import request_input
from google.genai import types

CONFIRMATION = 'adk_request_confirmation'
REQUESTS: list[list[dict]] = []
BODIES: list[str] = []


class Scripted(BaseLlm):
    calls: list[str]

    async def generate_content_async(self, llm_request, stream=False):
        REQUESTS.append([content.model_dump(mode='json', exclude_none=True) for content in llm_request.contents])
        if len(REQUESTS) == 1:
            parts = [types.Part(function_call=types.FunctionCall(
                id=f'call_{index}', name=name,
                args={'message': 'Which city?', 'response_schema': {'type': 'object', 'properties': {
                    'city': {'type': 'string'},
                }, 'required': ['city']}} if name == 'adk_request_input' else {'value': index + 1},
            )) for index, name in enumerate(self.calls)]
        else:
            parts = [types.Part(text='done')]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


def gated(value: int) -> dict:
    """Run the confirmed operation."""
    BODIES.append('gated')
    return {'gated': value}


def ordinary(value: int) -> dict:
    """Run an ordinary operation."""
    BODIES.append('ordinary')
    return {'ordinary': value}


def other(value: int) -> dict:
    """Run another ordinary operation."""
    BODIES.append('other')
    return {'other': value}


def pending(value: int) -> dict:
    """Start a long-running operation."""
    BODIES.append('pending')
    return {'pending': True}


async def measure(calls, approved=True, answer_order='combined'):
    """Stop at ADK's confirmation, or the pending result, before another model call."""
    REQUESTS.clear()
    BODIES.clear()
    tools = {
        'gated': FunctionTool(gated, require_confirmation=True),
        'ordinary': FunctionTool(ordinary), 'other': FunctionTool(other),
        'pending': LongRunningFunctionTool(pending), 'adk_request_input': request_input,
    }
    root = LlmAgent(name='root', instruction='Use the tools.', model=Scripted(model='scripted', calls=calls),
                    tools=[tools[name] for name in calls])
    runner = InMemoryRunner(agent=root, app_name='beside')
    await runner.session_service.create_session(app_name='beside', user_id='user', session_id='session')
    events = []

    async def drive(message, initial=False):
        stream = runner.run_async(user_id='user', session_id='session', new_message=message)
        try:
            async for event in stream:
                events.append(event.model_dump(mode='json', exclude_none=True))
                parts = event.content.parts or [] if event.content else []
                if initial and (
                    any(part.function_call and part.function_call.name == CONFIRMATION for part in parts)
                    or (not any(name == 'gated' for name in calls) and
                        any(part.function_response and part.function_response.name == 'pending' for part in parts))
                ):
                    break
        finally:
            await stream.aclose()

    await drive(types.Content(role='user', parts=[types.Part(text='question')]), initial=True)
    before = list(BODIES)
    confirmation = next((part['function_call'] for event in events for part in event.get('content', {}).get('parts', [])
                         if part.get('function_call', {}).get('name') == CONFIRMATION), None)
    responses = []
    if confirmation:
        responses.append(types.Part(function_response=types.FunctionResponse(
            id=confirmation['id'], name=CONFIRMATION, response={'confirmed': approved},
        )))
    for index, name in enumerate(calls):
        if name in ('pending', 'adk_request_input'):
            responses.append(types.Part(function_response=types.FunctionResponse(
                id=f'call_{index}', name=name, response={'answer': 'external'} if name == 'pending' else {'city': 'Hue'},
            )))
    batches = [responses] if answer_order == 'combined' else [[part] for part in (
        responses if answer_order == 'confirmation-first' else list(reversed(responses))
    )]
    request_counts = []
    for batch in batches:
        await drive(types.Content(role='user', parts=batch))
        request_counts.append(len(REQUESTS))
    return {'requests': copy.deepcopy(REQUESTS), 'before': before, 'bodies': list(BODIES),
            'request_counts': request_counts, 'events': events}


def responses_in(request):
    return [(part['function_response']['name'], part['function_response']['response'])
            for content in request for part in content.get('parts', []) if 'function_response' in part]


def assert_requests(result, calls):
    assert result['requests'][0] == [{'role': 'user', 'parts': [{'text': 'question'}]}]
    for request in result['requests'][1:]:
        assert request[0] == result['requests'][0][0]
        assert [part['function_call']['name'] for content in request
                for part in content.get('parts', []) if 'function_call' in part] == calls


@pytest.mark.parametrize('calls', [
    ['gated', 'ordinary'], ['ordinary', 'gated'], ['ordinary', 'gated', 'other'],
])
@pytest.mark.parametrize('approved', [True, False])
def test_ordinary_siblings_keep_every_result_and_never_run_twice(calls, approved):
    result = asyncio.run(measure(calls, approved))
    assert_requests(result, calls)
    assert result['request_counts'] == [2]
    assert result['before'] == [name for name in calls if name != 'gated']
    assert Counter(result['bodies']) == Counter(name for name in calls if name != 'gated' or approved)
    assert responses_in(result['requests'][1]) == [
        (name, {'error': 'This tool call is rejected.'} if name == 'gated' and not approved else {name: index + 1})
        for index, name in enumerate(calls)
    ]


@pytest.mark.parametrize('calls', [['gated', 'pending'], ['pending', 'gated']])
@pytest.mark.parametrize('approved', [True, False])
def test_combined_answer_loses_the_long_running_result(calls, approved):
    result = asyncio.run(measure(calls, approved))
    assert_requests(result, calls)
    assert result['before'] == ['pending']
    assert result['bodies'] == (['pending', 'gated'] if approved else ['pending'])
    assert result['request_counts'] == [2]
    assert responses_in(result['requests'][1]) == [
        (name, {'pending': True} if name == 'pending' else
         {'gated': index + 1} if approved else {'error': 'This tool call is rejected.'})
        for index, name in enumerate(calls)
    ]
    assert 'external' not in str(result['requests'][1])


@pytest.mark.parametrize('calls', [['gated', 'pending'], ['pending', 'gated']])
@pytest.mark.parametrize('approved', [True, False])
@pytest.mark.parametrize('order', ['confirmation-first', 'long-first'])
def test_split_answers_reach_the_model_in_separate_runs(calls, approved, order):
    result = asyncio.run(measure(calls, approved, order))
    assert_requests(result, calls)
    assert result['before'] == ['pending']
    assert Counter(result['bodies']) == Counter(['pending', 'gated'] if approved else ['pending'])
    assert result['request_counts'] == [2, 3]
    outcome = {'gated': calls.index('gated') + 1} if approved else {'error': 'This tool call is rejected.'}
    first = dict(responses_in(result['requests'][1]))
    assert first == ({'gated': outcome, 'pending': {'pending': True}} if order == 'confirmation-first' else {
        'gated': {'error': 'This tool call requires confirmation, please approve or reject.'},
        'pending': {'answer': 'external'},
    })
    assert dict(responses_in(result['requests'][2])) == {'gated': outcome, 'pending': {'answer': 'external'}}


def test_llm_agent_receives_the_native_request_input_answer():
    result = asyncio.run(measure(['adk_request_input']))
    assert_requests(result, ['adk_request_input'])
    assert result['before'] == result['bodies'] == []
    assert result['request_counts'] == [2]
    call = result['requests'][1][1]['parts'][0]['function_call']
    assert call['args'] == {'message': 'Which city?', 'response_schema': {
        'type': 'object', 'properties': {'city': {'type': 'string'}}, 'required': ['city'],
    }}
    assert responses_in(result['requests'][1]) == [('adk_request_input', {'city': 'Hue'})]
