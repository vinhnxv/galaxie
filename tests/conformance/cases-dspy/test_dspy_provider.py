# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native driver observations and independent plain-DSPy provider references."""

import asyncio
from collections import Counter
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType
from typing import Any

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, Usage
import pytest


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native = load_module('provider_native_driver', 'test_dspy_durable.py')
programs = load_module('provider_programs', 'provider_programs.py')
FIXTURES = json.loads(Path(__file__).with_name('provider-fixtures.json').read_text())
QUESTION = 'RESTORED_INPUT_SECRET'


class Store(native.Store):
    def __init__(self):
        super().__init__()
        self.payloads = []
        self.capability_requests = 0
        self.after_termination = 0
        self.orphans = 0
        self.terminated = False

    async def request(self, raw):
        message = json.loads(raw)
        if message['op'] in ('model', 'capability'):
            self.after_termination += int(self.terminated)
            if message['op'] == 'model':
                self.payloads.append(message['payload'])
            else:
                self.capability_requests += 1
        return await super().request(raw)

    def boot(self, name):
        transport = ModuleType('_galaxie_transport')
        setattr(transport, 'request', self.request)
        setattr(transport, 'notify', self.notify)
        sys.modules[transport.__name__] = transport
        selected = ModuleType('provider_selected')
        setattr(selected, 'create_agent', lambda: programs.factory(name))
        sys.modules[selected.__name__] = selected
        context = {'_galaxie_module': selected.__name__, '_galaxie_entry': 'create_agent', '_galaxie_durable': True}
        exec(native.DRIVER, context)
        assert context['_galaxie_ready'] == {'ok': True}
        return context

    async def execute_async(self, context):
        existing = asyncio.all_tasks()
        context['_galaxie_input'] = json.dumps({'threadId': 'session', 'steps': 10, 'input': {'question': QUESTION}})
        result = json.loads(await context['_galaxie_execute']())
        self.terminated = True
        tasks = [task for task in asyncio.all_tasks() - existing if not task.done()]
        self.orphans = len(tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return result

    def execute(self, context):
        return asyncio.run(self.execute_async(context))


class ScriptedEngine:
    def __init__(self, reply=programs.REPLY):
        self.reply, self.requests = reply, []

    async def complete(self, request):
        self.requests.append(request)
        return Response(id=None, model=request.model,
                        message=Message(role='assistant', parts=(TextPart(self.reply),)),
                        finish_reason='stop', usage=Usage(input_tokens=0, output_tokens=0, total_tokens=0))


class SyncEngine:
    def complete(self, request):
        raise AssertionError('Provider references must use the async engine.')


class PlainLM(dspy.LM):
    def __init__(self, engine, schema=False):
        self.schema = schema
        super().__init__('answer', engine=SyncEngine(), async_engine=engine,
                         cache=False, num_retries=0, temperature=None, max_tokens=None)

    @property
    def supported_params(self):
        return {'stop', 'response_format'} if self.schema else {'stop'}

    @property
    def supports_function_calling(self):
        return False

    @property
    def supports_response_schema(self):
        return self.schema


def native_reference_plain(kind):
    engine = ScriptedEngine()

    async def run():
        predictor = dspy.Predict(programs.signature_for(kind))
        predictor.set_lm(PlainLM(engine))
        return dict((await predictor.acall(question=QUESTION)).items())

    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with programs.egress_recorder(), dspy.context(
        adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[],
    ):
        output = asyncio.run(run())
    payloads = []
    for request in engine.requests:
        raw = request_kwargs(request, 'chat')
        messages = raw.pop('messages')
        raw.pop('model', None)
        payloads.append({'role': 'answer', 'messages': messages, 'options': raw})
    return {'output': output, 'requests': payloads}


@pytest.mark.parametrize('name', [name for name in FIXTURES['scenarios'] if name not in FIXTURES['nativeOnly']])
def test_native_provider_probe(name):
    store = Store()
    context = store.boot(name)
    result = store.execute(context)
    assert native.pending(context) is None
    assert (store.capability_requests, store.orphans, store.after_termination) == (0, 0, 0)
    evidence, = [event for event in store.events if event.get('kind') == 'provider-egress']
    assert evidence['recorder'] and not evidence['unexpected']
    assert set(evidence['attempts']) <= {'127.0.0.1:9'}
    count = 1 if name in ('pe-control-routed', 'pe-schema-typed-ok', 'pe-schema-typed-violation') else 0
    assert store.requests == count
    if name in ('pe-control-routed', 'pe-schema-typed-ok'):
        reference = native_reference_plain('literal' if name == 'pe-schema-typed-ok' else 'control')
        assert result == {'ok': True, 'output': reference['output']}
        canonical = lambda values: Counter(json.dumps(value, sort_keys=True) for value in values)
        assert canonical(store.payloads) == canonical(reference['requests'])
        assert all('jsonSchema' not in payload['options'] for payload in store.payloads)
    elif name == 'pe-env-facts':
        assert json.loads(result['output']['facts']) == FIXTURES['predictions']['P10']['native']
    elif name == 'pe-retrieve-local-rm':
        assert result == {'ok': True, 'output': {'passages': ['local a', 'local b']}}
    else:
        # Superseded by the provider-LM refusal; P2-P4 in provider-fixtures.json record the pre-refusal measurement.
        code = 'unsupported' if name in ('pe-lm-kwargs', 'pe-schema-response-format', 'pe-lm-runtime-set', 'pe-lm-runtime-context', 'pe-lm-runtime-nokey') else 'executor_error'
        assert result == {'ok': False, 'code': code}
    if name == 'pe-retrieve-colbert':
        assert len(evidence['attempts']) >= 1
    else:
        # Superseded by the provider-LM refusal; P2-P4 in provider-fixtures.json record the pre-refusal measurement.
        assert evidence['attempts'] == []
    print(json.dumps({'scenario': name, 'lane': 'native', 'requests': store.requests,
                      'capabilities': store.capability_requests, 'result': result, **evidence}, sort_keys=True))


def test_schema_candidate_shape():
    class MappingAnswer(dspy.Signature):
        question: str = dspy.InputField()
        answer: dict[str, Any] = dspy.OutputField()

    async def run(signature, reply):
        engine = ScriptedEngine(reply)
        predictor = dspy.Predict(signature)
        predictor.set_lm(PlainLM(engine, schema=True))
        with dspy.context(adapter=dspy.JSONAdapter(), disable_history=True, trace=None, callbacks=[]):
            await predictor.acall(question=QUESTION)
        return engine.requests[0].config.response_format

    with programs.egress_recorder():
        typed = asyncio.run(run(programs.LiteralAnswer, '{"answer":"done"}'))
        mapping = asyncio.run(run(MappingAnswer, '{"answer":{}}'))
    schema = typed.model_json_schema() if isinstance(typed, type) else typed
    if schema.get('type') == 'json_schema':
        schema = schema['schema']
    assert schema['type'] == 'object'
    assert mapping == {'type': 'json_object'}
    print(json.dumps({'scenario': 'pe-schema-candidate-shape', 'lane': 'native',
                      'typed': type(typed).__name__, 'schemaType': schema['type'], 'mapping': mapping}))


def test_provider_fixture_is_separate_and_complete():
    names = FIXTURES['scenarios']
    assert len(set(names)) == 15
    assert FIXTURES['nativeOnly'] == ['pe-schema-candidate-shape']
    for name in names:
        assert name.startswith('pe-')
        if name not in FIXTURES['nativeOnly']:
            assert programs.factory(name) is not None
    for path in Path(__file__).parent.glob('*fixtures.json'):
        if path.name != 'provider-fixtures.json':
            assert all(name not in path.read_text() for name in names)
