# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Plain DSPy schema reference: no provider connection or galaxie model engine."""

import json
from pathlib import Path
from unittest.mock import patch

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, Usage

from schema_programs import Program, QUESTION, adapter_for

CASES = json.loads(Path(__file__).with_name('schema-output-golden-cases.json').read_text())


class Engine:
    def __init__(self, reply):
        self.reply, self.requests, self.formats = reply, [], []

    async def complete(self, value):
        raw = request_kwargs(value, 'chat')
        self.formats.append(value.config.response_format)
        options = {}
        if 'response_format' in raw:
            format_ = raw['response_format']
            if format_['type'] == 'json_schema':
                options['jsonSchema'] = format_['json_schema']['schema']
        if raw.get('stop'):
            options['stop'] = raw['stop']
        self.requests.append({'messages': raw['messages'], **options})
        return Response(id=None, model='answer', message=Message(role='assistant', parts=(TextPart(self.reply),)), finish_reason='stop', usage=Usage())


class SyncEngine:
    def complete(self, value):
        raise AssertionError('Schema references use async DSPy.')


class PlainLM(dspy.LM):
    def __init__(self, engine):
        super().__init__('answer', engine=SyncEngine(), async_engine=engine, cache=False, num_retries=0, temperature=None, max_tokens=None)

    @property
    def supported_params(self):
        return {'stop', 'response_format', 'tool_choice'}

    @property
    def supports_response_schema(self):
        return True

    @property
    def supports_function_calling(self):
        return True


async def measure(name, reply):
    engine = Engine(reply)
    result = {'requests': engine.requests, 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Schema references forbid network.')), dspy.context(adapter=adapter_for(name), disable_history=True, trace=None, callbacks=[]):
        try:
            output = await Program(name, PlainLM(engine)).acall(question=QUESTION)
            result['output'] = dict(output.items())
        except Exception:
            result['error'] = {'code': 'executor_error', 'message': 'The executor or agent code failed.'}
    result['responses'] = [{'content': reply, 'toolCalls': []}] * len(engine.requests)
    return json.loads(json.dumps(result)), engine.formats


async def record_schema(name):
    case = CASES[name]
    if case.get('refused'):
        # These are galaxie policy refusals, not a claim that plain DSPy refuses.
        return {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None,
                'error': {'code': 'unsupported', 'message': 'This operation is unsupported.'}}
    return (await measure(name, case['reply']))[0]
