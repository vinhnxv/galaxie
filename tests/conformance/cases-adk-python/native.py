# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import importlib.util
import json
from pathlib import Path
import socket
import sys
from typing import Any
from unittest.mock import patch

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
        parts = ([types.Part(text=entry['text'])] if entry['text'] else []) + [
            types.Part(function_call=types.FunctionCall(name=call['name'], args=call['args']))
            for call in entry.get('toolCalls', [])
        ]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


class NativeDouble(BaseTool):
    """Independent native tool: same declaration, runs the fixture's arithmetic directly."""

    def __init__(self, case, transcript):
        super().__init__(name='double', description='Double an integer.')
        self.case = case
        self.transcript = transcript

    def _get_declaration(self):
        return types.FunctionDeclaration(
            name=self.name, description=self.description, parameters_json_schema=suite.PARAMETERS,
        )

    async def run_async(self, *, args, tool_context):
        self.transcript['capabilities'].append({'name': 'math.double@1', 'input': args})
        if self.case == 'capability-denial':
            return {'error': DENIED}
        return {'value': args['value'] * 2}


async def _run_case(name):
    spec = json.loads(Path(__file__).with_name('fixtures.json').read_text())[name]
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    model = ScriptedLlm(model='answer', case=name, spec=spec, transcript=transcript)
    agent = suite.factory(name, model, NativeDouble(name, transcript))
    runner = InMemoryRunner(agent=agent, app_name='conformance')
    session = await runner.session_service.create_session(app_name='conformance', user_id='user', session_id='conformance')
    last = None
    try:
        async for event in runner.run_async(
            user_id='user', session_id=session.id,
            new_message=types.Content(role='user', parts=[types.Part(text=spec['prompt'])]),
        ):
            if event.is_final_response() and event.content:
                last = ''.join(part.text or '' for part in event.content.parts or [])
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
