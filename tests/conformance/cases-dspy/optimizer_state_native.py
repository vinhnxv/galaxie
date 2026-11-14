# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Real offline optimizers driven only by scripted, network-denied engines."""

import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from unittest.mock import patch

import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, Usage
from galaxie.dspy import Executor, GalaxieError

import optimizer_state_suite as suite

spec = importlib.util.spec_from_file_location('dspy_optimizer_reference', Path(__file__).with_name('native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The native DSPy engine cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)

FIXTURES = json.loads(Path(__file__).with_name('optimizer-state-fixtures.json').read_text())
STATES = Path(__file__).with_name('optimizer-state')


class Engine(native.Engine):
    def __init__(self, name, transcript):
        self.name, self.transcript = name, transcript
        self.replies = iter(FIXTURES[name]['replies'])


class ScriptedEngine:
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = 0

    def complete(self, request):
        self.calls += 1
        payload = request_kwargs(request, 'chat')
        system = payload['messages'][0]['content']
        # Read only the output-field declaration, not the later formatting example.
        outputs = system.split('Your output fields are:', 1)[1].split('All interactions', 1)[0]
        fields = re.findall(r'`(\w+)`', outputs)
        values = self.fixture['proposals']
        text = '\n'.join(f'[[ ## {field} ## ]]\n{values[field] if field != "answer" else (self.fixture["trainset"][0]["answer"] if values["proposed_instruction"] in system else "Unknown")}' for field in fields)
        text += '\n[[ ## completed ## ]]'
        return Response(id=None, model=request.model, message=Message(role='assistant', parts=(TextPart(text),)), finish_reason='stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))


class AsyncScriptedEngine:
    def __init__(self, engine):
        self.engine = engine

    async def complete(self, request):
        return self.engine.complete(request)


def optimize(name):
    fixture = FIXTURES[name]
    engine = ScriptedEngine(fixture)
    lm = dspy.LM('offline', engine=engine, async_engine=AsyncScriptedEngine(engine), cache=False, num_retries=0)
    trainset = [dspy.Example(**row).with_inputs('question') for row in fixture['trainset']]
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Offline optimization forbids network.')), dspy.context(lm=lm, adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, callbacks=[]):
        module = dspy.COPRO(prompt_model=lm, metric=lambda expected, actual, trace=None: expected.answer == actual.answer,
                            breadth=2, depth=1).compile(suite.build(name), trainset=trainset,
                            eval_kwargs={'num_threads': 1, 'display_progress': False, 'display_table': False})
        if engine.calls != fixture['expectedEngineCalls'] or engine.calls == 0:
            raise AssertionError(f'Unexpected optimizer engine calls: {engine.calls}')
        module.set_lm(None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            module.save(path)
            return json.loads(path.read_text())


async def record(name):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Native optimizer state conformance forbids network.')), dspy.context(adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
        module = suite.program(name, native.NativeLM(Engine(name, transcript), False), STATES / f"{FIXTURES[name]['state']}.json")
        try:
            if name == 'optstate-forgot-lm':
                Executor(module)
                raise AssertionError('The missing LM must be refused.')
            result = await module.acall(question=FIXTURES[name]['question'])
            transcript['output'] = {key: result[key] for key in module.signature.output_fields}
        except GalaxieError as error:
            transcript['error'] = {'code': error.code, 'message': str(error)}
    return json.loads(json.dumps(transcript))
