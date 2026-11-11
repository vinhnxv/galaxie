# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native characterization and plain-DSPy references for runtime optimizer probes."""

import asyncio
from collections import Counter
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import ModuleType
from unittest.mock import patch

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, Usage
from galaxie import GalaxieError
import pytest


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native = load_module('runtime_native_driver', 'test_dspy_durable.py')
programs = load_module('runtime_programs', 'runtime_programs.py')
FIXTURES = json.loads(Path(__file__).with_name('runtime-fixtures.json').read_text())
QUESTION = 'RESTORED_INPUT_SECRET'


class Store(native.Store):
    def __init__(self):
        super().__init__()
        self.payloads = []
        self.capability_requests = 0
        self.after_termination = 0
        self.orphans = 0
        self.terminated = False
        self.replay_counts = []

    async def request(self, raw):
        message = json.loads(raw)
        if message['op'] in ('model', 'capability'):
            self.after_termination += int(self.terminated)
            if message['op'] == 'model':
                self.payloads.append(message['payload'])
            else:
                self.capability_requests += 1
        return await super().request(raw)

    def notify(self, raw):
        event = json.loads(raw)['payload'][2]
        if event.get('kind') == 'replayed':
            self.replay_counts.append((self.requests, self.capability_requests))
        super().notify(raw)

    def boot(self, name):
        transport = ModuleType('_galaxie_transport')
        setattr(transport, 'request', self.request)
        setattr(transport, 'notify', self.notify)
        sys.modules[transport.__name__] = transport
        selected = ModuleType('runtime_selected')
        setattr(selected, 'create_agent', lambda: programs.factory(name))
        sys.modules[selected.__name__] = selected
        context = {'_galaxie_module': selected.__name__, '_galaxie_entry': 'create_agent', '_galaxie_durable': True}
        exec(native.DRIVER, context)
        assert context['_galaxie_ready'] == {'ok': True}
        return context

    async def execute_async(self, context, pending=None):
        self.terminated = False
        existing = asyncio.all_tasks()
        context['_galaxie_input'] = json.dumps({
            'threadId': 'session', 'steps': 10,
            **({'input': {'question': QUESTION}} if pending is None else {
                'resume': {'interactionId': pending['id'], 'action': 'continue', 'payload': 'continue'},
            }),
        })
        result = json.loads(await context['_galaxie_execute']())
        self.terminated = True
        tasks = [task for task in asyncio.all_tasks() - existing if not task.done()]
        self.orphans += len(tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return result

    def execute(self, context, pending=None):
        with patch('socket.socket.connect', side_effect=AssertionError('Runtime probes forbid network.')):
            return asyncio.run(self.execute_async(context, pending))


def native_reference_labeled(two_stage=False, question=QUESTION):
    requests = []

    class Engine:
        def complete(self, request):
            raw = request_kwargs(request, 'chat')
            messages = raw.pop('messages')
            raw.pop('model', None)
            requests.append({'role': 'answer', 'messages': messages, 'options': raw})
            return Response(id=None, model=request.model,
                            message=Message(role='assistant', parts=(TextPart('[[ ## answer ## ]]\ndone\n[[ ## completed ## ]]'),)),
                            finish_reason='stop', usage=Usage(input_tokens=0, output_tokens=0, total_tokens=0))

    class AsyncEngine:
        async def complete(self, request):
            return Engine().complete(request)

    class LM(dspy.LM):
        def __init__(self):
            super().__init__('answer', engine=Engine(), async_engine=AsyncEngine(),
                             cache=False, num_retries=0, temperature=None, max_tokens=None)

        @property
        def supports_function_calling(self):
            return False

        @property
        def supports_response_schema(self):
            return False

        @property
        def supported_params(self):
            return set()

    async def run():
        predictor = dspy.Predict('question: str -> answer: str')
        compiled = dspy.LabeledFewShot(k=2).compile(predictor, trainset=programs.TRAINSET)
        compiled.set_lm(LM())
        first = await compiled.acall(question=question)
        output = {'answer': first.answer, 'demos': programs.demos_of(compiled)}
        if two_stage:
            last = await compiled.acall(question='continue')
            output.update(first=first.answer, answer=last.answer)
        return {'output': output, 'requests': requests}

    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Runtime reference forbids network.')), dspy.context(
        adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[],
    ):
        return asyncio.run(run())


def payloads(values):
    return Counter(json.dumps(value, sort_keys=True) for value in values)


def observe(name):
    store = Store()
    if name == 'rt-sync-forward-only':
        before = programs.FORWARD_CALLS
        with pytest.raises(GalaxieError) as refusal:
            programs.factory(name)
        assert refusal.value.code == 'unsupported'
        assert programs.FORWARD_CALLS == before
        result = {'ok': False, 'code': refusal.value.code}
    else:
        context = store.boot(name)
        result = store.execute(context)
        if name == 'rt-opt-labeled-two-stage':
            assert result == {'ok': True, 'interrupted': True}
            assert store.requests == 1
            before = native.pending(context)
            assert before is not None
            restored = store.boot(name)
            assert native.pending(restored) == before
            assert store.requests == 1
            result = store.execute(restored, before)
            assert store.replay_counts == [(1, 0)]
            assert store.requests == 2
    return {
        'result': result, 'requests': store.requests, 'capabilities': store.capability_requests,
        'orphans': store.orphans, 'afterTermination': store.after_termination,
        'payloads': store.payloads,
    }


def native_gepa_observation():
    script = f"""
import contextlib, importlib.util, io, json
spec = importlib.util.spec_from_file_location('runtime_probe', {str(Path(__file__).resolve())!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result = module.observe('rt-opt-gepa')
print(json.dumps(result))
"""
    try:
        process = subprocess.run([sys.executable, '-I', '-c', script], capture_output=True, text=True, timeout=120)
        if process.returncode != 0:
            return {'status': 'native-unmeasured', 'reason': f'GEPA subprocess exit {process.returncode}'}
        return json.loads(process.stdout)
    except subprocess.TimeoutExpired:
        return {'status': 'native-unmeasured', 'reason': 'GEPA subprocess exceeded 120 seconds'}
    except json.JSONDecodeError:
        return {'status': 'native-unmeasured', 'reason': 'GEPA subprocess did not return JSON'}


@pytest.mark.parametrize('name', FIXTURES['scenarios'])
def test_native_runtime_entry_points_and_optimizers(name):
    observed = native_gepa_observation() if name == 'rt-opt-gepa' else observe(name)
    if observed.get('status') == 'native-unmeasured':
        print(json.dumps({'scenario': name, **observed}))
        return
    result = observed['result']
    assert isinstance(result, dict)
    print(json.dumps({
        'scenario': name, 'ok': result['ok'], 'code': result.get('code'),
        **{key: observed[key] for key in ('requests', 'capabilities', 'orphans', 'afterTermination')},
    }))
    assert observed['capabilities'] == observed['orphans'] == observed['afterTermination'] == 0
    if name == 'rt-sync-acall-control':
        assert observed['result'] == {'ok': True, 'output': {'answer': 'done'}}
        assert observed['requests'] == 1
    elif name in ('rt-opt-labeled', 'rt-opt-labeled-two-stage'):
        reference = native_reference_labeled(two_stage=name.endswith('two-stage'))
        assert observed['result'] == {'ok': True, 'output': reference['output']}
        assert payloads(observed['payloads']) == payloads(reference['requests'])
        assert observed['requests'] == (2 if name.endswith('two-stage') else 1)
        if name.endswith('two-stage'):
            uninterrupted = Store()
            context = uninterrupted.boot(name)
            assert uninterrupted.execute(context) == {'ok': True, 'interrupted': True}
            pause = native.pending(context)
            assert pause is not None
            assert uninterrupted.execute(context, pause) == observed['result']
            assert payloads(uninterrupted.payloads) == payloads(observed['payloads'])
            assert uninterrupted.orphans == uninterrupted.after_termination == 0
    else:
        expected = 'executor_error' if name == 'rt-opt-labeled-naive' else 'unsupported'
        assert observed['result'] == {'ok': False, 'code': expected}
        assert observed['requests'] == 0


def test_runtime_family_has_exactly_fourteen_distinct_programs_without_collisions():
    names = FIXTURES['scenarios']
    assert len(names) == len(set(names)) == 14
    assert set(names) == set(programs.PROGRAMS)
    assert all(name.startswith('rt-') for name in names)
    for path in Path(__file__).parent.glob('*fixtures.json'):
        if path.name != 'runtime-fixtures.json':
            assert not any(name in path.read_text() for name in names)
    assert [dict(example.items()) for example in programs.TRAINSET] == FIXTURES['trainset']
