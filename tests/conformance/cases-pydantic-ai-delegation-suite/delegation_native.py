# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native agents share usage directly; the refusal reference encodes the adapter limit."""

import importlib.util
import json
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RequestUsage, UsageLimits

from galaxie import GalaxieError, capabilities

import delegation_suite as suite

spec = importlib.util.spec_from_file_location(
    'delegation_base_native_reference', Path(__file__).parent.parent / 'cases-pydantic-ai/native.py',
)
if spec is None or spec.loader is None:
    raise ImportError('The native reference cannot be loaded.')
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)

RELOAD_CASES = ('delegation-reload-write',)


async def _run_case(name, reload):
    fixture = json.loads(Path(__file__).with_name('fixtures.json').read_text())[name]
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [],
                  'output': None, 'error': None}
    mapper = OpenAIChatModel('conformance', provider=OpenAIProvider(api_key='unused-fixture-key'))

    class ScriptedModel(Model):
        def __init__(self, role):
            super().__init__(profile={'supports_tools': True, 'supports_text_output': True})
            self.role = role

        @property
        def model_name(self):
            return self.role

        @property
        def system(self):
            return 'fixture'

        async def request(self, messages, model_settings, model_request_parameters):
            if self.role == 'child' and name == 'delegation-nested-plain-refused':
                raise GalaxieError('unsupported')
            settings, parameters = self.prepare_request(model_settings, model_request_parameters)
            mapped = await mapper._map_messages(messages, parameters, model_settings=settings)
            for message in mapped:
                if message.get('content') is None:
                    message['content'] = ''
            tools = [mapper._map_tool_definition(tool, settings or {}) for tool in parameters.declared_tool_defs.values()]
            transcript['requests'].append({'messages': mapped, 'tools': tools,
                                           **({'toolChoice': 'auto'} if tools else {})})
            turn = sum(isinstance(message, ModelResponse) for message in messages)
            entry = fixture['scripts'][self.role][turn]
            transcript['responses'].append({'content': entry['text'], 'toolCalls': entry.get('toolCalls', [])})
            return ModelResponse(
                parts=([TextPart(entry['text'])] if entry['text'] else []) + [
                    ToolCallPart(call['name'], call['args'], tool_call_id=call['id']) for call in entry.get('toolCalls', [])
                ], usage=RequestUsage(input_tokens=2, output_tokens=2), model_name=self.role,
            )

    async def delegate(ctx, child, prompt):
        # Independent native budget sharing; no galaxie active box or helper.
        return await child.run(prompt, deps=ctx.deps, usage=ctx.usage, usage_limits=ctx.usage_limits, infer_name=False)

    def factory():
        return suite.factory(name, ScriptedModel('parent'), ScriptedModel('child'), delegate)

    async def call(capability, input, config=None, *, effect_scope=None, tool=False):
        transcript['capabilities'].append({'name': capability, 'input': input})
        return {'value': input['value'] * 2}

    previous = capabilities.call
    capabilities.call = call
    Agent.instrument_all(False)
    try:
        executor = factory()
        limits = UsageLimits(request_limit=fixture['steps'])
        result = await base.run_agent(executor.agent, fixture['prompt'], {
            'conversation_id': 'conformance', 'usage_limits': limits, 'infer_name': False,
        })
        while isinstance(result.output, DeferredToolRequests):
            requests = result.output
            assert executor.interaction is not None
            interaction = executor.interaction(requests)
            conversation = base.roundtrip_conversation(result) if reload else None
            if reload:
                previous_executor = executor
                executor = factory()
                assert conversation is not None
                assert executor.agent is not previous_executor.agent
                assert executor.interaction is not None
                assert executor.interaction(conversation.deferred_tool_requests) == interaction
            transcript['interactions'].append({'interactionId': 'pause-0', **interaction})
            results = DeferredToolResults(approvals={call.tool_call_id: True for call in requests.approvals})
            result = await base.run_agent(executor.agent, None, {
                **({'conversation': conversation} if conversation is not None else {
                    'conversation_id': 'conformance', 'message_history': result.all_messages(), 'usage': result.usage,
                }),
                'deferred_tool_results': results, 'usage_limits': limits, 'infer_name': False,
            })
        transcript['output'] = result.output
        if reload:
            assert base.roundtrip_conversation(result).deferred_tool_requests is None
    except UsageLimitExceeded:
        error = GalaxieError('budget_exceeded')
        transcript['error'] = {'code': error.code, 'message': str(error)}
    except GalaxieError as error:
        transcript['error'] = {'code': error.code, 'message': str(error)}
    finally:
        capabilities.call = previous
        await mapper.client.close()
    return base.normalized(transcript)


async def run_case(name, *, reload=False):
    if reload and name not in RELOAD_CASES:
        raise ValueError('The native delegation reload case is unknown.')
    with (
        patch.object(socket.socket, 'connect', base._blocked_network),
        patch.object(socket.socket, 'connect_ex', base._blocked_network),
        patch.object(socket, 'getaddrinfo', base._blocked_network),
    ):
        return await _run_case(name, reload)
