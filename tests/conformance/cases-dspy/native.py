# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

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
ERRORS['unrecoverable'] = 'Stored state cannot be recovered.'


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
        if FIXTURES.get(self.name, {}).get('unordered'):
            question = payload['messages'][-1]['content'].split('[[ ## question ## ]]\n', 1)[1].split('\n\n', 1)[0].strip()
            reply = next(item for item in FIXTURES[self.name]['replies'] if item['question'] == question)
        else:
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


class NativePause(BaseException):
    def __init__(self, value):
        self.value = value


class ReferenceReplay:
    """Compare full canonical requests, independently of galaxie's digest journal."""
    def __init__(self, transcript):
        self.transcript = transcript
        self.entries = []
        self.restart()

    def restart(self):
        self.position = 0
        self.recorded = len(self.entries)
        self.notified = False
        self.pausing = False
        self.models = self.tools = 0

    @property
    def replaying(self):
        return self.position < self.recorded

    def frontier(self):
        if self.replaying:
            raise Termination('unrecoverable')
        if self.recorded and not self.notified:
            self.notified = True
            self.transcript['events'].append({'mode': 'updates', 'data': {'kind': 'replayed', 'count': self.recorded}})

    def call(self, kind, request):
        if self.pausing:
            raise Termination('unsupported')
        canonical = json.loads(json.dumps(request, sort_keys=True))
        if self.replaying:
            entry = self.entries[self.position]
            if entry['kind'] != kind or entry['request'] != canonical or 'reply' not in entry:
                raise Termination('unrecoverable')
            replayed = True
        else:
            self.frontier()
            entry = {'kind': kind, 'request': canonical}
            self.entries.append(entry)
            replayed = False
        self.position += 1
        return entry, replayed

    def interaction(self, value):
        entry, replayed = self.call('interaction', value)
        if replayed:
            return json.loads(json.dumps(entry['reply']))
        self.pausing = True
        raise NativePause(value)


def canonical_request(request):
    payload = request_kwargs(request, 'chat')
    for message in payload['messages']:
        if message.get('content') is None:
            message['content'] = ''
        for call in message.get('tool_calls', []):
            call['function']['arguments'] = json.loads(call['function']['arguments'])
    return payload


def native_response(request, reply):
    parts = [TextPart(reply['text'])] if reply['text'] or not reply.get('toolCalls') else []
    parts += [ToolCallPart(id=call['id'], name=call['name'], input=call['args']) for call in reply.get('toolCalls', [])]
    return Response(id=None, model=request.model, message=Message(role='assistant', parts=tuple(parts)), finish_reason='tool_call' if reply.get('toolCalls') else 'stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))


class ReplayEngine:
    def __init__(self, name, reference):
        self.name, self.reference = name, reference
        self.replies = iter(FIXTURES[name]['replies'])

    def reply(self, request):
        reference = self.reference
        entry, replayed = reference.call('model', canonical_request(request))
        index = reference.models
        reference.models += 1
        if not replayed:
            if self.name.startswith('stream-'):
                reference.transcript['events'].append({'mode': 'updates', 'data': {'kind': 'model', 'index': index}})
            reference.transcript['requests'].append(canonical_request(request))
            reply = next(self.replies)
            reference.transcript['responses'].append({'content': reply['text'], 'toolCalls': reply.get('toolCalls', [])})
            entry['reply'] = reply
        return entry['reply']

    async def complete(self, request):
        return native_response(request, self.reply(request))

    async def stream(self, request):
        reply = self.reply(request)
        yield StreamStartEvent(model=request.model)
        for text in reply['chunks']:
            yield StreamDeltaEvent(TextDelta(text))
        yield StreamEndEvent(finish_reason='stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))

    async def aclose(self):
        pass


class ReplayLM(NativeLM):
    def __init__(self, engine):
        super().__init__(engine, False)
        self.reference = engine.reference

    async def acall(self, prompt=None, *, messages=None, **kwargs):
        if self.reference.replaying:
            with dspy.context(send_stream=None):
                return await super().acall(prompt, messages=messages, **kwargs)
        return await super().acall(prompt, messages=messages, **kwargs)


def pause_failure(error):
    leaves = []
    def visit(item):
        if isinstance(item, BaseExceptionGroup):
            for child in item.exceptions:
                visit(child)
        else:
            leaves.append(item)
    visit(error)
    failures = [item for item in leaves if isinstance(item, (Failure, Termination))]
    if failures:
        raise failures[0]
    pauses = [item for item in leaves if isinstance(item, NativePause)]
    if len(pauses) > 1:
        raise Termination('unsupported')
    if len(pauses) == 1 and all(isinstance(item, (NativePause, asyncio.CancelledError)) for item in leaves):
        return pauses[0]
    raise Termination('executor_error')


async def record_pauses(name):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None, 'events': []}
    reference = ReferenceReplay(transcript)
    streaming = name.startswith('stream-')
    engine = ReplayEngine(name, reference)
    async def lookup(query: str) -> str:
        entry, replayed = reference.call('capability', {'name': 'docs.lookup@1', 'input': {'query': query}})
        index = reference.tools
        reference.tools += 1
        if not replayed:
            if streaming:
                transcript['events'].append({'mode': 'updates', 'data': {'kind': 'tool', 'name': 'lookup', 'index': index}})
            transcript['capabilities'].append({'name': 'docs.lookup@1', 'input': {'query': query}})
            entry['reply'] = 'Paris'
        return entry['reply']
    tool = dspy.Tool(lookup, name='lookup', desc='Look up the fact.', args={'query': {'type': 'string'}}, arg_types={})
    module = suite.program(name, ReplayLM(engine), tool, reference.interaction)
    answers = iter(FIXTURES[name].get('resumes', []))
    class SilentStatus(StatusMessageProvider):
        def tool_start_status_message(self, instance, inputs) -> Any:
            pass
        def tool_end_status_message(self, outputs) -> Any:
            pass
    try:
        with patch('socket.socket.connect', side_effect=AssertionError('Native conformance forbids network.')), dspy.context(adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
            for _ in range(FIXTURES[name].get('runs', 1)):
                reference.entries = []
                reference.restart()
                while True:
                    try:
                        if streaming:
                            stream: Any = dspy.streamify(module, is_async_program=True, async_streaming=True,
                                stream_listeners=[ReferenceListener('answer')], status_message_provider=SilentStatus())
                            result: Any = None
                            async for item in stream(question='What is the capital of France?'):
                                if isinstance(item, StreamResponse) and item.chunk:
                                    transcript['events'].append({'mode': 'messages', 'data': {'field': item.signature_field_name, 'text': item.chunk}})
                                elif isinstance(item, dspy.Prediction):
                                    result = item
                        else:
                            result = await module.acall(question='What is the capital of France?')
                        reference.frontier()
                        signature = getattr(module, 'signature', None)
                        transcript['output'] = {key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items())
                        break
                    except BaseException as error:
                        pause = pause_failure(error)
                        reference.frontier()
                        if len(json.dumps({'journal': reference.entries, 'pending': pause.value}, ensure_ascii=False).encode()) > 1024 * 1024:
                            raise Termination('unsupported')
                        transcript['interactions'].append(pause.value)
                        transcript['events'].append({'mode': 'updates', 'data': {'kind': 'pause'}})
                        reference.entries[-1]['reply'] = next(answers)
                        reference.restart()
    except BaseException as error:
        code = error.code if isinstance(error, (Failure, Termination)) and error.code in ERRORS else 'executor_error'
        if code == 'unrecoverable':
            transcript['events'].append({'mode': 'updates', 'data': {'kind': 'unrecoverable'}})
        transcript['error'] = {'code': code, 'message': ERRORS[code]}
    normalized = []
    for event in transcript['events']:
        if event['mode'] == 'messages' and normalized and normalized[-1]['mode'] == 'messages' and normalized[-1]['data']['field'] == event['data']['field']:
            normalized[-1]['data']['text'] += event['data']['text']
        else:
            normalized.append(event)
    transcript['events'] = normalized
    return json.loads(json.dumps(transcript))


async def record(name):
    if 'pause-' in name:
        return await record_pauses(name)
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
    if FIXTURES[name].get('unordered'):
        transcript['requests'].sort(key=lambda item: item['messages'][-1]['content'])
        transcript['responses'].sort(key=lambda item: item['content'])
        transcript['capabilities'].sort(key=lambda item: item['input']['query'])
    return json.loads(json.dumps(transcript))
