# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Shipped-code characterization and reusable gated driver for fan-out probes."""

import asyncio
from collections import Counter
import hashlib
import importlib.util
import json
import logging
from pathlib import Path
import sys
from types import ModuleType
from typing import Any
from unittest.mock import patch

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


native = load_module('parallel_native_driver', 'test_dspy_durable.py')
programs = load_module('parallel_programs', 'parallel_programs.py')
FIXTURES = json.loads(Path(__file__).with_name('parallel-fixtures.json').read_text())
LABELS = programs.LABELS


def payloads(values):
    return Counter(json.dumps(value, sort_keys=True) for value in values)


class Store(native.Store):
    def __init__(self, order='forward'):
        super().__init__()
        self.order = order
        self.question = 'fan-out'
        self.model_labels = []
        self.model_payloads = []
        self.arrivals = []
        self.completions = []
        self.labels = LABELS
        self.crash_after_writes: int | None = None
        self.hold_models = False
        self.orphans = 0
        self.after_termination = 0
        self.journal_at_return = []
        self._gates = {}
        self._terminated = False

    async def gate(self, kind, query):
        label, phase = query.split(':')[:2]
        key = (kind, phase)
        gates = self._gates.setdefault(key, {})
        event = gates.setdefault(label, asyncio.Event())
        order = [item for item in FIXTURES['orders'][self.order] if item in self.labels]
        order += [item for item in self.labels if item not in order]
        if len(gates) == len(order):
            gates[order[0]].set()
        await event.wait()
        index = order.index(label)
        if index + 1 < len(order):
            gates[order[index + 1]].set()

    async def request(self, raw):
        message = json.loads(raw)
        op, value = message['op'], message['payload']
        if op not in {'model', 'capability'}:
            return await super().request(raw)
        if self._terminated:
            self.after_termination += 1
        code = None
        if op == 'model':
            self.requests += 1
            query = programs.model_question(value['messages'])
            self.model_labels.append(query)
            self.model_payloads.append(value)
            self.arrivals.append(query)
            if self.hold_models:
                await asyncio.Event().wait()
            await self.gate(op, query)
            self.completions.append(query)
            result = {'content': programs.reply_text(query)}
        else:
            query = value['input']['query']
            await self.gate(op, query)
            if self.crash_after_writes is not None and len(self.calls) >= self.crash_after_writes:
                await asyncio.Event().wait()
            scope = value['effectScope']
            digest = hashlib.sha256(json.dumps(value['input'], sort_keys=True).encode()).hexdigest()
            previous = self.effects.get(scope)
            if previous:
                code = 'unrecoverable' if previous['digest'] != digest else 'outcome_unknown' if previous['status'] == 'dispatched' else None
                result = previous.get('output')
            else:
                self.calls.append(query)
                result = 'receipt:' + query
                self.effects[scope] = {'digest': digest, 'status': 'succeeded', 'output': result}
                if len(self.calls) == self.crash_after_writes:
                    # Worker loss cancels the owning execution, not just one
                    # TaskGroup child (whose cancellation alone is non-fatal).
                    assert self._owner is not None
                    self._owner.cancel()
                    raise asyncio.CancelledError()
        return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': code is None, **({'error': {'code': code}} if code else {'payload': result})})

    def boot(self, name, candidate=False, changed=False):
        self.labels = (*LABELS, 'delta') if name == 'par-fan-eval-loop' else LABELS
        if changed == 'removed':
            self.labels = LABELS[:2]
        self.hold_models = name == 'par-fan-pause-in-branch'
        transport = ModuleType('_galaxie_transport')
        setattr(transport, 'request', self.request)
        setattr(transport, 'notify', self.notify)
        sys.modules[transport.__name__] = transport
        selected = ModuleType('parallel_selected')
        setattr(selected, 'create_agent', lambda: programs.factory(name, candidate=candidate, changed=changed))
        sys.modules[selected.__name__] = selected
        context = {'_galaxie_module': selected.__name__, '_galaxie_entry': 'create_agent', '_galaxie_durable': True}
        exec(native.DRIVER, context)
        assert context['_galaxie_ready'] == {'ok': True}
        return context

    async def execute_async(self, context, pending=None):
        self._gates = {}
        self._terminated = False
        self._owner = asyncio.current_task()
        assert self._owner is not None
        existing = asyncio.all_tasks()
        context['_galaxie_input'] = json.dumps({'threadId': 'session', 'steps': 50, **({'input': {'question': self.question}} if pending is None else {'resume': {'interactionId': pending['id'], 'action': 'continue', 'payload': 'continue'}})})
        result = json.loads(await context['_galaxie_execute']())
        self._terminated = True
        executor = context['_galaxie_executor']
        conversation = context['_galaxie_conversations'].get('session')
        state = executor._sessions.get(conversation)
        self.journal_at_return = [] if state is None else list(state.journal)
        tasks = [task for task in asyncio.all_tasks() - existing if not task.done()]
        self.orphans = len(tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return result

    def execute(self, context, pending=None):
        return asyncio.run(self.execute_async(context, pending))


def complete(store, name, *, candidate=False, changed=False):
    context = store.boot(name, candidate=candidate, changed=changed)
    result = store.execute(context)
    if result == {'ok': True, 'interrupted': True}:
        before = native.pending(context)
        assert before is not None
        context = store.boot(name, candidate=candidate, changed=changed)
        assert native.pending(context) == before
        result = store.execute(context, before)
    return result


def native_reference(shape='single', *, stage='before', evaluate=False, threads=3):
    requests = []

    class Engine:
        def complete(self, request):
            raw = request_kwargs(request, 'chat')
            messages = raw.pop('messages')
            raw.pop('model', None)
            requests.append({'role': 'answer', 'messages': messages, 'options': raw})
            query = programs.model_question(messages)
            return Response(id=None, model=request.model, message=Message(role='assistant', parts=(TextPart(programs.reply_text(query)),)), finish_reason='stop', usage=Usage(input_tokens=0, output_tokens=0, total_tokens=0))

    class LM(dspy.LM):
        def __init__(self):
            super().__init__('answer', engine=Engine(), cache=False, num_retries=0, temperature=None, max_tokens=None)

        @property
        def supports_function_calling(self):
            return False

        @property
        def supports_response_schema(self):
            return False

        @property
        def supported_params(self):
            return set()

    class Branch(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(LM())

        def forward(self, question):
            if shape == 'write':
                return dspy.Prediction(answer='receipt:' + question)
            first = self.predict(question=question)
            if shape == 'multi':
                label = question.split(':')[0]
                last = self.predict(question=f'{label}:last-{stage}')
                return dspy.Prediction(answer={'first': first.answer, 'receipt': 'receipt:' + question, 'answer': last.answer})
            return first

    labels = (*LABELS, 'delta') if evaluate else LABELS
    examples = [dspy.Example(question=f'{label}:{stage}', answer=f'{label}:{stage}').with_inputs('question') for label in labels]
    branch = Branch()
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Native fan-out probes forbid network.')), dspy.context(adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
        if evaluate:
            result = dspy.Evaluate(devset=examples, num_threads=threads, display_progress=False, display_table=False)(branch, metric=lambda example, prediction: float(example.answer == prediction.answer))
            return {'answers': [prediction.answer for _, prediction, _ in result.results], 'score': result.score}, requests
        result = dspy.Parallel(num_threads=threads, disable_progress_bar=True)([(branch, example) for example in examples])
        return {'answers': [prediction.answer for prediction in result]}, requests


@pytest.mark.parametrize('name', [name for name in FIXTURES['scenarios'] if name.startswith(('par-verbatim-', 'par-refuse-'))])
def test_verbatim_and_propagated_context_refusal(name, caplog):
    store = Store()
    logger = logging.getLogger('dspy.utils.parallelizer')
    logger.addHandler(caplog.handler)
    try:
        result = complete(store, name)
    finally:
        logger.removeHandler(caplog.handler)
    if name == 'par-verbatim-thread-start':
        assert result == {'ok': True, 'output': {'thread': 'started', 'pool': 'started'}}
    else:
        assert result == {'ok': False, 'code': 'unsupported'}
    assert store.requests == 0 and store.calls == []
    assert store.orphans == 0 and store.after_termination == 0
    if name == 'par-verbatim-parallel-threads':
        records = [record for record in caplog.records if record.name == logger.name]
        print(json.dumps({'scenario': name, 'parallelizerLogRecords': len(records), 'itemTextLogged': any('alpha:before' in record.getMessage() for record in records)}))


@pytest.mark.parametrize('order', FIXTURES['orders'])
@pytest.mark.parametrize('name,shape', [('par-fan-single', 'single'), ('par-fan-write', 'write'), ('par-fan-multi', 'multi'), ('par-fan-eval-loop', 'single')])
def test_fan_out_matches_native_dspy_before_replay(name, shape, order):
    store = Store(order)
    result = complete(store, name)
    expected, requests = native_reference(shape, evaluate=name == 'par-fan-eval-loop')
    assert result == {'ok': True, 'output': expected}
    assert payloads(store.model_payloads) == payloads(requests)
    assert store.orphans == 0
    if name != 'par-fan-write':
        assert Counter(store.arrivals[:3]) == Counter(f'{label}:before' for label in LABELS)
        assert store.completions[:3] == [f'{label}:before' for label in FIXTURES['orders'][order]]


@pytest.mark.parametrize('threads', [1, 3])
def test_async_evaluate_reference_matches_native_evaluate(threads):
    reference, _ = native_reference(evaluate=True, threads=threads)
    assert reference == {'answers': [f'{label}:before' for label in (*LABELS, 'delta')], 'score': 100.0}


def test_shipped_evaluate_replacement_records_reload_outcome():
    store = Store('reversed')
    store.question = 'reload'
    name = 'par-fan-eval-loop'
    context = store.boot(name)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests = store.requests
    context = store.boot(name)
    assert native.pending(context) == before
    result = store.execute(context, before)
    print(json.dumps({'scenario': name, 'result': result, 'resumeRequests': store.requests - requests}, sort_keys=True))
    if result['ok']:
        expected, _ = native_reference(evaluate=True)
        assert result == {'ok': True, 'output': expected}
    else:
        assert result == {'ok': False, 'code': 'unrecoverable'}
    assert store.requests == requests


def test_shipped_pause_inside_branch_leaves_a_sibling_until_harness_cleanup():
    store = Store()
    result = complete(store, 'par-fan-pause-in-branch')
    assert result == {'ok': False, 'code': 'unsupported'}
    assert store.requests == 1 and store.orphans == 1
    assert store.journal_at_return == []
    assert store.after_termination == 0


def test_shipped_concurrent_pauses_end_with_a_fixed_refusal():
    store = Store()
    assert complete(store, 'par-fan-concurrent-pauses') == {'ok': False, 'code': 'unsupported'}
    assert store.orphans == 0 and store.requests == 0


@pytest.mark.parametrize('order', FIXTURES['orders'])
@pytest.mark.parametrize('shape', ['single', 'multi'])
def test_shipped_replay_records_actual_request_start_order(shape, order):
    store = Store(order)
    name = 'par-fan-two-stage-' + shape
    context = store.boot(name)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests = store.requests
    initial_order = list(store.arrivals)
    store.order = 'reversed' if order == 'forward' else 'forward'
    context = store.boot(name)
    assert native.pending(context) == before
    result = store.execute(context, before)
    observation = {'scenario': name, 'order': order, 'requestStartOrder': initial_order, 'result': result, 'resumeRequests': store.requests - requests, 'writes': len(store.calls)}
    print(json.dumps(observation, sort_keys=True))
    if result['ok']:
        first, _ = native_reference(shape)
        second, _ = native_reference(shape, stage='after')
        assert result['output'] == {'before': first['answers'], 'answers': second['answers']}
        assert store.requests - requests == (6 if shape == 'multi' else 3)
        assert sum(event.get('kind') == 'replayed' for event in store.events) == 1
    else:
        assert result == {'ok': False, 'code': 'unrecoverable'}
        assert store.requests == requests


@pytest.mark.parametrize('changed', [True, 'removed'])
def test_shipped_divergence_is_refused_before_dispatch(changed):
    store = Store()
    name = 'par-fan-diverge'
    context = store.boot(name)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests = store.requests
    context = store.boot(name, changed=changed)
    assert native.pending(context) == before
    assert store.execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert store.requests == requests and store.calls == []


@pytest.mark.parametrize('name', ['par-fan-write', 'par-fan-multi'])
def test_shipped_crash_redispatch_records_receipt_identity(name):
    store = Store('forward')
    context = store.boot(name)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    store.crash_after_writes = 2
    context = store.boot(name)
    assert native.pending(context) == before
    assert store.execute(context, before) == {'ok': False, 'code': 'cancelled'}
    assert len(store.calls) == 2
    store.crash_after_writes = None
    store.order = 'reversed'
    context = store.boot(name)
    assert native.pending(context) == before
    result = store.execute(context, before)
    print(json.dumps({'scenario': name, 'result': result, 'writes': store.calls, 'effects': store.effects}, sort_keys=True))
    if name == 'par-fan-write':
        expected, _ = native_reference('write')
        assert result == {'ok': True, 'output': expected}
        assert Counter(store.calls) == Counter(f'{label}:before' for label in LABELS)
    else:
        assert result == {'ok': False, 'code': 'unrecoverable'}
        # A sibling may commit under a newly allocated scope before the host's
        # mismatched receipt reaches the executor. Preserve this shipped hazard.
        assert 2 <= len(store.calls) <= 3
        assert store.calls[:2] == ['alpha:before', 'beta:before']
