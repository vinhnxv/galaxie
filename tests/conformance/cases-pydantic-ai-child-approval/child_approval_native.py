# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Independent native child approval hoist with serialized conversations."""

import importlib.util
import json
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from pydantic_ai import Agent, ApprovalRequired, ConversationTypeAdapter, DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RequestUsage, UsageLimits

from galaxie import capabilities

import child_approval_suite as suite

spec = importlib.util.spec_from_file_location(
    'child_approval_base_native_reference', Path(__file__).parent.parent / 'cases-pydantic-ai/native.py',
)
if spec is None or spec.loader is None:
    raise ImportError('The native reference cannot be loaded.')
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)

RELOAD_CASES = ('child-approval-restore',)
CHILD_STATE = 'native.child-approval'


def child_requests(requests):
    children = {}
    for call in requests.approvals:
        conversation = ConversationTypeAdapter.validate_json(requests.metadata[call.tool_call_id][CHILD_STATE])
        assert conversation.deferred_tool_requests is not None
        children[call.tool_call_id] = conversation.deferred_tool_requests
    return children


async def delegate(ctx, child, prompt, *, hoist_approvals):
    assert hoist_approvals
    options = {'deps': ctx.deps, 'usage': ctx.usage, 'usage_limits': ctx.usage_limits, 'infer_name': False}
    if ctx.tool_call_approved:
        conversation = ConversationTypeAdapter.validate_json(ctx.tool_call_metadata[CHILD_STATE])
        requests = conversation.deferred_tool_requests
        assert requests is not None
        options.update({
            'conversation_id': conversation.conversation_id, 'message_history': conversation.messages,
            'deferred_tool_results': requests.build_results(approve_all=True, metadata=requests.metadata),
        })
        prompt = None
    result = await child.run(prompt, **options)
    if isinstance(result.output, DeferredToolRequests):
        raise ApprovalRequired(metadata={CHILD_STATE: ConversationTypeAdapter.dump_json(result.conversation).decode()})
    return result


async def _run_case(name, reload):
    fixture = json.loads(Path(__file__).with_name('fixtures.json').read_text())
    action = fixture['cases'][name]['action']
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

    def factory():
        return suite.factory(name, ScriptedModel('parent'), ScriptedModel('child'), delegate, child_requests)

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
        assert isinstance(result.output, DeferredToolRequests)
        requests = result.output
        assert executor.interaction is not None
        interaction = executor.interaction(requests)
        assert not transcript['capabilities']
        conversation = base.roundtrip_conversation(result) if reload else None
        if reload:
            previous_executor = executor
            executor = factory()
            assert conversation is not None
            assert executor.agent is not previous_executor.agent
            assert executor.interaction is not None
            assert executor.interaction(conversation.deferred_tool_requests) == interaction
        transcript['interactions'].append({'interactionId': 'pause-0', **interaction})
        results = DeferredToolResults(
            approvals={call.tool_call_id: action == 'approve' for call in requests.approvals},
            metadata=requests.metadata if action == 'approve' else {},
        )
        result = await base.run_agent(executor.agent, None, {
            **({'conversation': conversation} if conversation is not None else {
                'conversation_id': 'conformance', 'message_history': result.all_messages(), 'usage': result.usage,
            }),
            'deferred_tool_results': results, 'usage_limits': limits, 'infer_name': False,
        })
        assert not isinstance(result.output, DeferredToolRequests)
        transcript['output'] = result.output
        assert result.usage.requests == (3 if action == 'deny' else 4)
        assert base.roundtrip_conversation(result).deferred_tool_requests is None
    finally:
        capabilities.call = previous
        await mapper.client.close()
    return base.normalized(transcript)


async def run_case(name, *, reload=False):
    if reload and name not in RELOAD_CASES:
        raise ValueError('The native child approval reload case is unknown.')
    with (
        patch.object(socket.socket, 'connect', base._blocked_network),
        patch.object(socket.socket, 'connect_ex', base._blocked_network),
        patch.object(socket, 'getaddrinfo', base._blocked_network),
    ):
        return await _run_case(name, reload)
