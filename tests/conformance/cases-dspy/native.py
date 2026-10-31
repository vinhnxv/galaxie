# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Independent native engine: DSPy's own dialect supplies request payloads."""

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any
from unittest.mock import patch

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, StreamDeltaEvent, StreamEndEvent, StreamStartEvent, TextDelta, TextPart, ToolCallDelta, ToolCallPart, Usage
from dspy.streaming import StatusMessageProvider, StreamListener, StreamResponse
from dspy.signatures import make_signature
from dspy.utils.exceptions import AdapterParseError

suite_spec = importlib.util.spec_from_file_location('dspy_conformance_suite', Path(__file__).with_name('suite.py'))
if suite_spec is None or suite_spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
suite = importlib.util.module_from_spec(suite_spec)
sys.modules[suite_spec.name] = suite
suite_spec.loader.exec_module(suite)

FIXTURES = json.loads(Path(__file__).with_name('fixtures.json').read_text())
ERRORS = {'denied': 'Policy denied the request.', 'outcome_unknown': 'The outcome of an earlier call is unknown.', 'unsupported': 'This operation is unsupported.', 'executor_error': 'The executor or agent code failed.', 'cancelled': 'The run was cancelled.', 'invalid': 'The request is invalid.'}


class Failure(dspy.LMError):
    pass


class Termination(BaseException):
    def __init__(self, code):
        self.code = code


class SyncEngine:
    def complete(self, request):
        raise AssertionError('Native reference must run asynchronously.')


class Engine:
    def __init__(self, name, transcript):
        self.name, self.transcript = name, transcript
        self.replies = iter(FIXTURES[name]['replies'])

    def reply(self, request):
        payload = request_kwargs(request, 'chat')
        for message in payload['messages']:
            if message.get('content') is None:
                message['content'] = ''
            for call in message.get('tool_calls', []):
                call['function']['arguments'] = json.loads(call['function']['arguments'])
        self.transcript['requests'].append(payload)
        reply = next(self.replies)
        if self.name == 'abort':
            raise Failure(ERRORS['cancelled'], code='cancelled')
        self.transcript['responses'].append({'content': reply['text'], 'toolCalls': reply.get('toolCalls', [])})
        return reply

    async def complete(self, request):
        if 'events' in self.transcript:
            self.transcript['events'].append({'mode': 'updates', 'data': {'kind': 'model', 'index': len(self.transcript['requests'])}})
        reply = self.reply(request)
        if 'BLOCKED_' in json.dumps(reply):
            raise Failure(ERRORS['denied'], code='denied')
        parts = [TextPart(reply['text'])] if reply['text'] or not reply.get('toolCalls') else []
        parts += [ToolCallPart(id=call['id'], name=call['name'], input=call['args']) for call in reply.get('toolCalls', [])]
        return Response(id=None, model=request.model, message=Message(role='assistant', parts=tuple(parts)), finish_reason='tool_call' if reply.get('toolCalls') else 'stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))

    async def stream(self, request):
        index = len(self.transcript['requests'])
        self.transcript['events'].append({'mode': 'updates', 'data': {'kind': 'model', 'index': index}})
        reply = self.reply(request)
        yield StreamStartEvent(model=request.model)
        growing = ''
        # Native scripts frame complete ChatAdapter delimiters; the fragmented
        # transport case must preserve those same visible field values.
        for index, text in enumerate(reply['chunks']):
            growing += text
            if 'BLOCKED_' in growing:
                raise Failure(ERRORS['denied'], code='denied')
            yield StreamDeltaEvent(TextDelta(text))
            if self.name == 'stream-abort' and index == 1:
                # Let streamify deliver the already checked prefix before abort.
                while not any(event['mode'] == 'messages' for event in self.transcript['events']):
                    await asyncio.sleep(0)
                raise Failure(ERRORS['cancelled'], code='cancelled')
        if 'BLOCKED_' in json.dumps(reply.get('toolCalls', [])):
            raise Failure(ERRORS['denied'], code='denied')
        if self.name == 'stream-final-mismatch':
            raise Failure(ERRORS['invalid'], code='invalid')
        for index, call in enumerate(reply.get('toolCalls', [])):
            yield StreamDeltaEvent(ToolCallDelta(input=json.dumps(call['args']), id=call['id'], name=call['name'], part_index=index + (1 if reply['text'] else 0)))
        yield StreamEndEvent(finish_reason='tool_call' if reply.get('toolCalls') else 'stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))

    async def aclose(self):
        pass


class NativeLM(dspy.LM):
    def __init__(self, engine, native):
        super().__init__('answer', engine=SyncEngine(), async_engine=engine, cache=False, num_retries=0, temperature=None, max_tokens=None)
        self.native = native

    @property
    def supports_function_calling(self):
        return self.native

    @property
    def supports_response_schema(self):
        return False

    @property
    def supported_params(self):
        return {'tool_choice'} if self.native else set()


class ReferenceListener(StreamListener):
    """Independently project scripted prefixes with DSPy's complete ChatAdapter parser."""
    def __init__(self, field):
        super().__init__(field)
        self.text = ''
        self.emitted = ''
        self.reference_signature = make_signature(f'-> {field}')
        self.reference_adapter = dspy.ChatAdapter(use_json_adapter_fallback=False)

    def receive(self, chunk):
        choice = chunk.choices[0]
        if choice.finish_reason is not None:
            self.text = self.emitted = ''
        if choice.delta.content is None:
            return None
        self.text += choice.delta.content
        try:
            value = self.reference_adapter.parse(self.reference_signature, self.text)[self.signature_field_name]
        except AdapterParseError:
            return None
        assert value.startswith(self.emitted), 'The scripted prefix is not stable.'
        delta, self.emitted = value[len(self.emitted):], value
        return StreamResponse(self.predict_name or '', self.signature_field_name, delta, False) if delta else None

    def finalize(self):
        return None


async def record(name):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    streaming = name.startswith('stream-')
    base = suite.base_name(name)
    if streaming:
        transcript['events'] = []
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    engine = Engine(name, transcript)
    async def lookup(query: str) -> str:
        """Look up the fact."""
        if streaming:
            transcript['events'].append({'mode': 'updates', 'data': {'kind': 'tool', 'name': 'lookup', 'index': len(transcript['capabilities'])}})
        transcript['capabilities'].append({'name': 'docs.lookup@1', 'input': {'query': query}})
        if base in {'capability-denial', 'outcome-unknown'}:
            raise Termination('denied' if base == 'capability-denial' else 'outcome_unknown')
        return 'Paris'
    tool = dspy.Tool(lookup, name='lookup', desc='Look up the fact.', args={'query': {'type': 'string'}}, arg_types={})
    module = suite.program(name, NativeLM(engine, base in {'native-tool-calling', 'argument-block'}), tool)
    adapter = dspy.JSONAdapter() if base == 'json-adapter' else dspy.ChatAdapter(use_json_adapter_fallback=False, use_native_function_calling=base in {'native-tool-calling', 'argument-block'})
    try:
        if name == 'refused-lm':
            raise Failure(ERRORS['unsupported'], code='unsupported')
        with patch('socket.socket.connect', side_effect=AssertionError('Native conformance forbids network.')), dspy.context(adapter=adapter, disable_history=True, trace=None, callbacks=[]):
            if streaming:
                if base == 'json-adapter':
                    raise Failure(ERRORS['unsupported'], code='unsupported')
                class SilentStatus(StatusMessageProvider):
                    def tool_start_status_message(self, instance, inputs) -> Any:
                        pass
                    def tool_end_status_message(self, outputs) -> Any:
                        pass
                field = 'next_thought' if base in {'native-tool-calling', 'argument-block'} else 'answer'
                stream: Any = dspy.streamify(module, is_async_program=True, async_streaming=True,
                    stream_listeners=[ReferenceListener(field)], status_message_provider=SilentStatus())
                result: Any = None
                async for item in stream(question='What is the capital of France?'):
                    if isinstance(item, StreamResponse) and item.chunk:
                        transcript['events'].append({'mode': 'messages', 'data': {'field': item.signature_field_name, 'text': item.chunk}})
                    elif isinstance(item, dspy.Prediction):
                        result = item
            else:
                result = await module.acall(question='What is the capital of France?')
        signature = getattr(module, 'signature', None)
        transcript['output'] = {key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items())
    except BaseException as error:
        def code_for(error):
            if isinstance(error, BaseExceptionGroup):
                return next((code for child in error.exceptions if (code := code_for(child)) is not None), None)
            return error.code if isinstance(error, (Failure, Termination)) and error.code in ERRORS else None
        code = code_for(error) or 'executor_error'
        transcript['error'] = {'code': code, 'message': ERRORS[code]}
    if streaming:
        normalized = []
        for event in transcript['events']:
            if event['mode'] == 'messages' and normalized and normalized[-1]['mode'] == 'messages' and normalized[-1]['data']['field'] == event['data']['field']:
                normalized[-1]['data']['text'] += event['data']['text']
            else:
                normalized.append(event)
        transcript['events'] = normalized
    return json.loads(json.dumps(transcript))
