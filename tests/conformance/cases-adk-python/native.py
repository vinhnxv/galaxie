# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import contextlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import sys
from typing import Any
from unittest.mock import patch

from google.adk.agents.run_config import RunConfig, StreamingMode  # pyright: ignore[reportPrivateImportUsage]
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools.base_tool import BaseTool
from google.genai import types

from galaxie import GalaxieError

suite_spec = importlib.util.spec_from_file_location('adk_python_conformance_suite', Path(__file__).with_name('suite.py'))
if suite_spec is None or suite_spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
suite = importlib.util.module_from_spec(suite_spec)
sys.modules[suite_spec.name] = suite
suite_spec.loader.exec_module(suite)

STEP_LIMIT = 2
CONFIRMATION = 'adk_request_confirmation'
DENIED = 'Policy denied the request.'


def normalized(value):
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def renumber(requests):
    """Provider call IDs differ per lane (ADK generates one, galaxie assigns one); number them by appearance."""
    known = {}

    def number(identifier):
        return known.setdefault(identifier, f'call-{len(known) + 1}')

    for request in requests:
        for message in request['messages']:
            for call in message.get('tool_calls', []):
                call['id'] = number(call['id'])
            if 'tool_call_id' in message:
                message['tool_call_id'] = number(message['tool_call_id'])
    return requests


def map_request(llm_request):
    """ADK turns as OpenAI chat messages and tools, written independently of galaxie's mapper."""
    messages = []
    instruction = llm_request.config.system_instruction
    if instruction:
        messages.append({'role': 'system', 'content': instruction})
    # ADK strips the IDs it generated before a request, so the fixture pairs calls and responses by order.
    issued = []
    waiting = []
    for content in llm_request.contents:
        if content.role == 'model':
            calls = []
            for part in content.parts:
                if part.function_call:
                    identifier = part.function_call.id or f'native-{len(issued) + 1}'
                    issued.append(identifier)
                    waiting.append(identifier)
                    calls.append({
                        'id': identifier, 'type': 'function',
                        'function': {'name': part.function_call.name, 'arguments': json.dumps(part.function_call.args, separators=(',', ':'))},
                    })
            text = ''.join(part.text or '' for part in content.parts if not part.function_call)
            messages.append({'role': 'assistant', 'content': text, **({'tool_calls': calls} if calls else {})})
            continue
        for part in content.parts:
            if part.function_response:
                messages.append({
                    'role': 'tool', 'tool_call_id': part.function_response.id or waiting.pop(0),
                    'content': json.dumps(part.function_response.response, separators=(',', ':')),
                })
        text = ''.join(part.text or '' for part in content.parts if part.text)
        if text:
            messages.append({'role': 'user', 'content': text})
    tools = [{'type': 'function', 'function': {
        'name': declaration.name, 'description': declaration.description,
        'parameters': declaration.parameters_json_schema,
    }} for tool in llm_request.config.tools or [] for declaration in tool.function_declarations or []]
    request: dict[str, Any] = {'messages': messages, 'tools': tools}
    schema = llm_request.config.response_json_schema
    if schema is None and llm_request.config.response_schema is not None:
        schema = llm_request.config.response_schema.model_json_schema()
    if schema is not None:
        request['jsonSchema'] = schema
    return request


class ScriptedLlm(BaseLlm):
    """Independent native model: records ADK's request and answers from the fixture."""

    case: str
    spec: Any
    transcript: Any

    async def generate_content_async(self, llm_request, stream=False):
        transcript = self.transcript
        if self.case == 'step-budget' and len(transcript['responses']) >= STEP_LIMIT:
            raise GalaxieError('budget_exceeded')
        transcript['requests'].append(map_request(llm_request))
        if self.case == 'abort':
            # ADK ends a cancelled root node quietly, so the fixture records the outcome itself.
            transcript['error'] = {'code': 'cancelled', 'message': 'The run was cancelled.'}
            raise asyncio.CancelledError()
        entry = self.spec['replies'][len(transcript['responses'])]
        transcript['responses'].append({'content': entry['text'], 'toolCalls': entry.get('toolCalls', [])})
        if self.case == 'argument-block':
            raise GalaxieError('denied')
        if stream and self.case.startswith('stream-'):
            # The router checks growing text before the model sees it; the fixture emulates that check.
            shown = ''
            for chunk in re.findall(r'\S+\s*', entry['text']):
                if 'BLOCKED_TEXT' in shown + chunk:
                    raise GalaxieError('denied')
                shown += chunk
                yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text=chunk)]), partial=True)
                if self.case == 'stream-abort':
                    transcript['error'] = {'code': 'cancelled', 'message': 'The run was cancelled.'}
                    raise asyncio.CancelledError()
        parts = ([types.Part(text=entry['text'])] if entry['text'] else []) + [
            types.Part(function_call=types.FunctionCall(name=call['name'], args=call['args']))
            for call in entry.get('toolCalls', [])
        ]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


class NativeDouble(BaseTool):
    """Independent native tool: same declaration, runs the fixture's arithmetic directly."""

    def __init__(self, case, transcript):
        super().__init__(name='double', description='Double an integer.', is_long_running=case == 'long-running')
        self.case = case
        self.transcript = transcript

    async def check_require_confirmation(self, args, tool_context):
        return self.case in suite.CONFIRMATION_CASES

    def _get_declaration(self):
        return types.FunctionDeclaration(
            name=self.name, description=self.description, parameters_json_schema=suite.PARAMETERS,
        )

    async def run_async(self, *, args, tool_context):
        self.transcript['capabilities'].append({'name': 'math.double@1', 'input': args})
        if self.case == 'capability-denial':
            return {'error': DENIED}
        return {'value': args['value'] * 2}


def project(event, streams, base):
    """The streamed view of an ADK event, written independently of galaxie's projection.

    Tool markers are numbered from `base`, the first marker of the current run; returns the next number.
    """
    parts = event.content.parts if event.content else []
    if event.partial:
        text = ''.join(part.text or '' for part in parts)
        if text:
            streams.append({'mode': 'messages', 'data': {'author': event.author, 'text': text}})
        return base
    for part in parts:
        call, response = part.function_call, part.function_response
        # ADK's own confirmation request is not an offered tool; the pause has its own marker.
        if (call or response) and (call or response).name != CONFIRMATION:
            streams.append({'mode': 'updates', 'data': {
                'step': 'tool_call' if call else 'tool_result', 'tool': (call or response).name, 'index': base,
            }})
            base += 1
    return base


async def converse(runner, session, spec, name, transcript):
    """Run the case natively: a pause ends a run and the answer is a new run, as ADK documents it."""
    streaming = 'streams' in transcript
    message = types.Content(role='user', parts=[types.Part(text=spec['prompt'])])
    answers = iter(spec.get('answers', []))
    pauses = 0
    last = None
    while True:
        asks = []
        flagged = []
        position = 0
        stream = runner.run_async(
            user_id='user', session_id=session.id, new_message=message,
            run_config=RunConfig(streaming_mode=StreamingMode.SSE if streaming else StreamingMode.NONE),
        )
        async with contextlib.aclosing(stream):
            async for event in stream:
                if streaming:
                    position = project(event, transcript['streams'], position)
                if event.partial:
                    continue
                parts = event.content.parts if event.content else []
                calls = [part.function_call for part in parts if part.function_call]
                for call in calls:
                    if call.name == CONFIRMATION:
                        original = call.args['originalFunctionCall']
                        asks.append(('confirmation', call.id, CONFIRMATION, original['name'], original.get('args') or {}))
                    elif call.id in (event.long_running_tool_ids or ()):
                        flagged.append(('long-running', call.id, call.name, call.name, call.args or {}))
                if calls:
                    continue
                if flagged and not asks:
                    # A long-running call's pending result has arrived: the run waits for the real one.
                    break
                if event.is_final_response() and event.content:
                    last = ''.join(part.text or '' for part in event.content.parts or [])
        asks = asks or flagged
        if not asks:
            return last
        requests = [{'kind': kind, 'tool': tool, 'args': args} for kind, _, _, tool, args in asks]
        transcript['interactions'].append({'interactionId': f'pause-{pauses}', **suite.hooks(name)['interaction'](requests)})
        pauses += 1
        if streaming:
            for index, (_, _, _, tool, _) in enumerate(asks):
                transcript['streams'].append({'mode': 'updates', 'data': {'step': 'paused', 'tool': tool, 'index': position + index}})
        if name == 'confirm-stale':
            raise GalaxieError('stale')
        answer = next(answers)
        if name == 'confirm-double-submit':
            transcript['dispatches'] = ['accepted', 'rejected:duplicate']
        parts = []
        if name == 'long-running':
            parts.append(types.Part(function_response=types.FunctionResponse(
                id=asks[0][1], name=asks[0][2], response=answer['payload'],
            )))
        else:
            indexes = answer['payload'].get('indexes')
            if answer['action'] not in ('approve', 'deny') or sorted(indexes) != list(range(len(asks))):
                raise GalaxieError('invalid')
            for _, identifier, gate, _, _ in asks:
                parts.append(types.Part(function_response=types.FunctionResponse(
                    id=identifier, name=gate, response={'confirmed': answer['action'] == 'approve'},
                )))
        message = types.Content(role='user', parts=parts)


async def _run_case(name):
    spec = json.loads(Path(__file__).with_name('fixtures.json').read_text())[name]
    streaming = name.startswith('stream-')
    transcript = {
        'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None,
        **({'streams': []} if streaming else {}),
    }
    model = ScriptedLlm(model='answer', case=name, spec=spec, transcript=transcript)
    agent = suite.factory(name, model, NativeDouble(name, transcript))
    runner = InMemoryRunner(agent=agent, app_name='conformance')
    session = await runner.session_service.create_session(app_name='conformance', user_id='user', session_id='conformance')
    last = None
    try:
        last = await converse(runner, session, spec, name, transcript)
        stored = await runner.session_service.get_session(app_name='conformance', user_id='user', session_id=session.id)
        transcript['output'] = stored.state['result'] if name == 'output-schema' and stored else last
    except asyncio.CancelledError:
        transcript['error'] = {'code': 'cancelled', 'message': 'The run was cancelled.'}
    except GalaxieError as error:
        transcript['error'] = {'code': error.code, 'message': str(error)}
    transcript['requests'] = renumber(transcript['requests'])
    return normalized(transcript)


def _blocked_network(*args, **kwargs):
    raise AssertionError('Network access is disabled in native conformance.')


async def run_case(name):
    with (
        patch.object(socket.socket, 'connect', _blocked_network),
        patch.object(socket.socket, 'connect_ex', _blocked_network),
        patch.object(socket, 'getaddrinfo', _blocked_network),
    ):
        return await _run_case(name)
