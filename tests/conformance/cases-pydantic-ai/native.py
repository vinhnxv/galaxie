# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib.util
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from pydantic_ai import Agent, ConversationTypeAdapter, DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import (
    ModelResponse, ModelResponseStreamEvent, PartDeltaEvent, PartStartEvent,
    TextPart, TextPartDelta, ToolCallPart,
)
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RequestUsage
from pydantic_core import to_jsonable_python

from galaxie import GalaxieError, capabilities
from galaxie.pydantic_ai import Executor

suite_spec = importlib.util.spec_from_file_location('pydantic_conformance_suite', Path(__file__).with_name('suite.py'))
if suite_spec is None or suite_spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
suite = importlib.util.module_from_spec(suite_spec)
sys.modules[suite_spec.name] = suite
suite_spec.loader.exec_module(suite)

RELOAD_CASES = (
    'approval-approve', 'approval-deny', 'approval-mixed', 'call-deferred',
    'approval-consecutive', 'stream-approval-approve', 'approval-invalid-action', 'approval-incomplete',
)


def normalized(value):
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


class NativeStream(StreamedResponse):
    """Independent native stream with deterministic provider and fault fixtures."""

    def __init__(self, parameters: ModelRequestParameters, response: ModelResponse, name: str) -> None:
        super().__init__(model_request_parameters=parameters)
        self.response = response
        self.name = name
        self._usage = response.usage

    async def _get_event_iterator(self) -> AsyncIterator[ModelResponseStreamEvent]:
        for part in self.response.parts:
            if isinstance(part, TextPart):
                for index, delta in enumerate(re.findall(r'\S+\s*', part.content)):
                    if self.name == 'stream-mid-block' and 'BLOCKED_TEXT' in delta:
                        raise GalaxieError('denied')
                    for event in self._parts_manager.handle_text_delta(vendor_part_id='text', content=delta):
                        yield event
                    if self.name == 'stream-abort' and index == 0:
                        raise asyncio.CancelledError()
        if self.name == 'stream-id-block':
            raise GalaxieError('denied')
        if self.name == 'stream-final-mismatch':
            raise GalaxieError('invalid')
        for index, part in enumerate(self.response.parts):
            if isinstance(part, ToolCallPart):
                yield self._parts_manager.handle_tool_call_part(
                    vendor_part_id=index, tool_name=part.tool_name,
                    args=part.args_as_json_str(), tool_call_id=part.tool_call_id,
                )

    async def close_stream(self) -> None:
        pass

    @property
    def model_name(self) -> str:
        return 'answer'

    @property
    def provider_name(self) -> None:
        return None

    @property
    def provider_url(self) -> None:
        return None

    @property
    def timestamp(self) -> datetime:
        return self.response.timestamp


async def run_agent(agent, prompt, options, streams=None):
    if streams is None:
        return await agent.run(prompt, **options)
    request_index = 0
    async with agent.iter(prompt, **options) as run:
        async for node in run:
            if Agent.is_model_request_node(node):
                streams.append({'mode': 'updates', 'data': {'kind': 'model-request', 'index': request_index}})
                request_index += 1
                async with node.stream(run.ctx) as events:
                    async for event in events:
                        if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                            text = event.part.content
                        elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                            text = event.delta.content_delta
                        else:
                            continue
                        if text:
                            streams.append({'mode': 'messages', 'data': [{'type': 'ai', 'content': text}, {}]})
            elif Agent.is_call_tools_node(node):
                for index, part in enumerate(node.model_response.parts):
                    if isinstance(part, ToolCallPart):
                        streams.append({'mode': 'updates', 'data': {'kind': 'tool-call', 'name': part.tool_name, 'index': index}})
        if run.result is None:
            raise GalaxieError('executor_error')
        return run.result


def roundtrip_conversation(result):
    original = result.conversation
    saved = ConversationTypeAdapter.dump_json(original)
    conversation = ConversationTypeAdapter.validate_json(saved)
    assert conversation.conversation_id == 'conformance'
    assert to_jsonable_python(conversation.usage) == to_jsonable_python(original.usage)
    assert conversation.usage.requests > 0
    assert to_jsonable_python(conversation) == to_jsonable_python(original)
    return conversation


async def run_deferred(executor, spec, name, transcript, reload_factory=None):
    pause = 0
    previous_requests = 0
    for _ in range(2 if name == 'approval-repeated-ids' else 1):
        result = await run_agent(executor.agent, spec['prompt'], {'conversation_id': 'conformance'}, transcript.get('streams'))
        answer_index = 0
        while isinstance(result.output, DeferredToolRequests):
            requests = result.output
            conversation = None
            if reload_factory is not None:
                conversation = roundtrip_conversation(result)
                assert conversation.usage.requests > previous_requests
                previous_requests = conversation.usage.requests
                previous = executor
                executor = reload_factory()
                assert executor is not previous and executor.agent is not previous.agent
                requests = conversation.deferred_tool_requests
                assert requests is not None
                assert executor.interaction(requests) == previous.interaction(result.output)
            if name == 'approval-invalid-interaction':
                raise GalaxieError('unsupported')
            if 'streams' in transcript:
                transcript['streams'].append({'mode': 'updates', 'data': {'kind': 'deferred'}})
            transcript['interactions'].append({'interactionId': f'pause-{pause}', **executor.interaction(requests)})
            pause += 1
            if name == 'approval-stale':
                raise GalaxieError('stale')
            answer = spec['answers'][answer_index]
            answer_index += 1
            if name == 'approval-double-submit':
                transcript['dispatches'] = ['accepted', 'rejected:duplicate']
            if name in ('approval-mixed', 'call-deferred'):
                results = DeferredToolResults(**answer['payload'])
            else:
                ids = [call.tool_call_id for call in requests.approvals]
                if answer['action'] not in ('approve', 'deny') or answer['payload'] != {'toolCallIds': ids}:
                    raise GalaxieError('invalid')
                results = DeferredToolResults(approvals={identifier: answer['action'] == 'approve' for identifier in ids})
            result = await run_agent(executor.agent, None, {
                **({'conversation': conversation} if conversation is not None else {
                    'conversation_id': 'conformance', 'message_history': result.all_messages(),
                }),
                'deferred_tool_results': results,
            }, transcript.get('streams'))
        transcript['output'] = to_jsonable_python(result.output)
        if reload_factory is not None:
            assert roundtrip_conversation(result).deferred_tool_requests is None


async def _run_case(name, *, reload=False):
    spec = json.loads(Path(__file__).with_name('fixtures.json').read_text())[name]
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    streaming = name.startswith('stream-')
    if streaming:
        transcript['streams'] = []
    charged_repairs = 0
    mapper = OpenAIChatModel('conformance', provider=OpenAIProvider(api_key='unused-fixture-key'), profile={
        'supports_tools': True, 'supports_text_output': True,
        'supports_json_schema_output': False, 'supports_json_object_output': False,
        'default_structured_output_mode': 'tool',
    })

    class ScriptedModel(Model):
        def __init__(self):
            super().__init__(profile={
                'supports_tools': True, 'supports_text_output': True,
                'supports_json_schema_output': True, 'supports_json_object_output': False,
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
            return await self._response(messages, settings, parameters)

        @asynccontextmanager
        async def request_stream(self, messages, model_settings, model_request_parameters, run_context=None):
            settings, parameters = self.prepare_request(model_settings, model_request_parameters)
            response = await self._response(messages, settings, parameters)
            yield NativeStream(parameters, response, name)

        async def _response(self, messages, settings, parameters):
            nonlocal charged_repairs
            if parameters.output_mode == 'native':
                # The reference has no bridge index, so derive it from its own history.
                repair = sum(isinstance(message, ModelResponse) for message in messages)
                route = spec.get('route', {})
                if repair:
                    if repair > route.get('repairAttempts', 0):
                        raise GalaxieError('invalid')
                    if charged_repairs >= route.get('runRepairBudget', 2):
                        raise GalaxieError('budget_exceeded')
                    charged_repairs += 1
            mapped = await mapper._map_messages(messages, parameters, model_settings=settings)
            for message in mapped:
                if message.get('content') is None:
                    message['content'] = ''
            tools = [mapper._map_tool_definition(tool, settings or {}) for tool in parameters.declared_tool_defs.values()]
            request = {'messages': mapped, 'tools': tools}
            if parameters.output_mode == 'native':
                constraint = mapper._map_json_schema(parameters.output_object)
                assert constraint['type'] == 'json_schema'
                assert 'schema' in constraint['json_schema']
                request['jsonSchema'] = constraint['json_schema']['schema']
            if tools:
                request['toolChoice'] = 'auto' if parameters.allow_text_output else 'required'
            transcript['requests'].append(normalized(request))
            if name == 'abort':
                raise asyncio.CancelledError()
            entry = spec['replies'][len(transcript['responses']) % len(spec['replies'])]
            response = {'content': entry['text'], 'toolCalls': entry.get('toolCalls', [])}
            transcript['responses'].append(normalized(response))
            if name == 'argument-block' or name.endswith('approval-argument-block'):
                raise GalaxieError('denied')
            return ModelResponse(
                parts=([TextPart(entry['text'])] if entry['text'] else []) + [
                    ToolCallPart(call['name'], call['args'], tool_call_id=call['id']) for call in entry.get('toolCalls', [])
                ], usage=RequestUsage(input_tokens=2, output_tokens=2), model_name='answer',
            )

    async def call(capability, input, config=None, *, effect_scope=None, tool=False):
        attempt = {'name': capability, 'input': input}
        transcript['capabilities'].append(attempt)
        if name == 'capability-denial':
            raise GalaxieError('denied')
        return {'value': input['value'] * 2}

    previous = capabilities.call
    capabilities.call = call
    Agent.instrument_all(False)
    try:
        agent = suite.factory(name, ScriptedModel())
        if isinstance(agent, Executor):
            await run_deferred(
                agent, spec, name, transcript,
                reload_factory=(lambda: suite.factory(name, ScriptedModel())) if reload else None,
            )
        else:
            result = await run_agent(agent, spec['prompt'], {'conversation_id': 'conformance'}, transcript.get('streams'))
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


async def run_reload_case(name):
    """Native persistence reference, independent of galaxie's byte-record driver."""
    if name not in RELOAD_CASES:
        raise ValueError('The native reload case is unknown.')
    with (
        patch.object(socket.socket, 'connect', _blocked_network),
        patch.object(socket.socket, 'connect_ex', _blocked_network),
        patch.object(socket, 'getaddrinfo', _blocked_network),
    ):
        return await _run_case(name, reload=True)
