# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import importlib.util
import json
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RequestUsage
from pydantic_core import to_jsonable_python

from galaxie import GalaxieError, capabilities

suite_spec = importlib.util.spec_from_file_location('pydantic_conformance_suite', Path(__file__).with_name('suite.py'))
if suite_spec is None or suite_spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
suite = importlib.util.module_from_spec(suite_spec)
sys.modules[suite_spec.name] = suite
suite_spec.loader.exec_module(suite)


def normalized(value):
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


async def _run_case(name):
    spec = json.loads(Path(__file__).with_name('fixtures.json').read_text())[name]
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    mapper = OpenAIChatModel('conformance', provider=OpenAIProvider(api_key='unused-fixture-key'), profile={
        'supports_tools': True, 'supports_text_output': True,
        'supports_json_schema_output': False, 'supports_json_object_output': False,
        'default_structured_output_mode': 'tool',
    })

    class ScriptedModel(Model):
        def __init__(self):
            super().__init__(profile={
                'supports_tools': True, 'supports_text_output': True,
                'supports_json_schema_output': False, 'supports_json_object_output': False,
                'default_structured_output_mode': 'tool',
            })

        @property
        def model_name(self):
            return 'answer'

        @property
        def system(self):
            return 'fixture'

        async def request(self, messages, model_settings, model_request_parameters):
            settings, parameters = self.prepare_request(model_settings, model_request_parameters)
            mapped = await mapper._map_messages(messages, parameters, model_settings=settings)
            for message in mapped:
                if message.get('content') is None:
                    message['content'] = ''
            tools = [mapper._map_tool_definition(tool, settings or {}) for tool in parameters.declared_tool_defs.values()]
            request = {'messages': mapped, 'tools': tools}
            if tools:
                request['toolChoice'] = 'auto' if parameters.allow_text_output else 'required'
            transcript['requests'].append(normalized(request))
            if name == 'abort':
                raise asyncio.CancelledError()
            entry = spec['replies'][len(transcript['responses'])]
            response = {'content': entry['text'], 'toolCalls': entry.get('toolCalls', [])}
            transcript['responses'].append(normalized(response))
            if name == 'argument-block':
                raise GalaxieError('denied')
            return ModelResponse(
                parts=([TextPart(entry['text'])] if entry['text'] else []) + [
                    ToolCallPart(call['name'], call['args'], tool_call_id=call['id']) for call in entry.get('toolCalls', [])
                ], usage=RequestUsage(input_tokens=2, output_tokens=2), model_name='answer',
            )

    async def call(capability, input, config=None, *, effect_scope=None):
        attempt = {'name': capability, 'input': input}
        transcript['capabilities'].append(attempt)
        if name == 'capability-denial':
            raise GalaxieError('denied')
        return {'value': input['value'] * 2}

    previous = capabilities.call
    capabilities.call = call
    Agent.instrument_all(False)
    try:
        result = await suite.factory(name, ScriptedModel()).run(spec['prompt'], conversation_id='conformance')
        transcript['output'] = to_jsonable_python(result.output)
    except asyncio.CancelledError:
        transcript['error'] = {'code': 'cancelled', 'message': 'The run was cancelled.'}
    except GalaxieError as error:
        transcript['error'] = {'code': error.code, 'message': str(error)}
    finally:
        capabilities.call = previous
        await mapper.client.close()
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
