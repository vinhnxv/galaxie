# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Independent native engine: DSPy's own dialect supplies request payloads."""

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, ToolCallPart, Usage

suite_spec = importlib.util.spec_from_file_location('dspy_conformance_suite', Path(__file__).with_name('suite.py'))
if suite_spec is None or suite_spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
suite = importlib.util.module_from_spec(suite_spec)
sys.modules[suite_spec.name] = suite
suite_spec.loader.exec_module(suite)

FIXTURES = json.loads(Path(__file__).with_name('fixtures.json').read_text())
ERRORS = {'denied': 'Policy denied the request.', 'outcome_unknown': 'The outcome of an earlier call is unknown.', 'unsupported': 'This operation is unsupported.', 'executor_error': 'The executor or agent code failed.', 'cancelled': 'The run was cancelled.'}


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

    async def complete(self, request):
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
        if 'BLOCKED_' in json.dumps(reply):
            raise Failure(ERRORS['denied'], code='denied')
        parts = [TextPart(reply['text'])] if reply['text'] or not reply.get('toolCalls') else []
        parts += [ToolCallPart(id=call['id'], name=call['name'], input=call['args']) for call in reply.get('toolCalls', [])]
        return Response(id=None, model=request.model, message=Message(role='assistant', parts=tuple(parts)), finish_reason='tool_call' if reply.get('toolCalls') else 'stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))

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


async def record(name):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    engine = Engine(name, transcript)
    async def lookup(query: str) -> str:
        """Look up the fact."""
        transcript['capabilities'].append({'name': 'docs.lookup@1', 'input': {'query': query}})
        if name in {'capability-denial', 'outcome-unknown'}:
            raise Termination('denied' if name == 'capability-denial' else 'outcome_unknown')
        return 'Paris'
    tool = dspy.Tool(lookup, name='lookup', desc='Look up the fact.', args={'query': {'type': 'string'}}, arg_types={})
    module = suite.program(name, NativeLM(engine, name in {'native-tool-calling', 'argument-block'}), tool)
    adapter = dspy.JSONAdapter() if name == 'json-adapter' else dspy.ChatAdapter(use_json_adapter_fallback=False, use_native_function_calling=name in {'native-tool-calling', 'argument-block'})
    try:
        if name == 'refused-lm':
            raise Failure(ERRORS['unsupported'], code='unsupported')
        with patch('socket.socket.connect', side_effect=AssertionError('Native conformance forbids network.')), dspy.context(adapter=adapter, disable_history=True, trace=None, callbacks=[]):
            result = await module.acall(question='What is the capital of France?')
        signature = getattr(module, 'signature', None)
        transcript['output'] = {key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items())
    except BaseException as error:
        code = error.code if isinstance(error, (Failure, Termination)) and error.code in ERRORS else 'executor_error'
        transcript['error'] = {'code': code, 'message': ERRORS[code]}
    return json.loads(json.dumps(transcript))
