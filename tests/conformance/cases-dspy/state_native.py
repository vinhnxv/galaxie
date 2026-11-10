# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Offline optimizers and independent CPython recordings; never call a provider."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import dspy
from dspy.lm15 import Message, Response, TextPart, Usage
from galaxie.dspy import Executor, GalaxieError

import state_suite as suite

spec = importlib.util.spec_from_file_location('dspy_state_reference', Path(__file__).with_name('native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The native DSPy engine cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)

FIXTURES = json.loads(Path(__file__).with_name('state-fixtures.json').read_text())
STATES = Path(__file__).with_name('state')


class Engine(native.Engine):
    def __init__(self, name, transcript):
        self.name, self.transcript = name, transcript
        self.replies = iter(FIXTURES[name]['replies'])


class OfflineEngine:
    def __init__(self, trainset):
        self.trainset = trainset
        self.calls = 0

    def complete(self, request):
        example = self.trainset[self.calls]
        self.calls += 1
        text = f"[[ ## reasoning ## ]]\nUse the offline fact for {example['question']}.\n[[ ## answer ## ]]\n{example['answer']}\n[[ ## completed ## ]]"
        return Response(id=None, model=request.model, message=Message(role='assistant', parts=(TextPart(text),)), finish_reason='stop', usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))


class AsyncOfflineEngine:
    async def complete(self, request):
        raise AssertionError('Offline optimization must use the synchronous engine.')


def optimize(name):
    fixture = FIXTURES[name]
    trainset = [dspy.Example(**row).with_inputs('question') for row in fixture.get('trainset', [])]
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Offline optimization forbids network.')), dspy.context(adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, callbacks=[]):
        module = suite.build(name)
        if name in {'state-predict-demos', 'state-react-demos'}:
            module = dspy.LabeledFewShot(k=2).compile(module, trainset=trainset, sample=False)
        elif name == 'state-chain-of-thought-bootstrap':
            engine = OfflineEngine(fixture['trainset'])
            lm = dspy.LM('offline', engine=engine, async_engine=AsyncOfflineEngine(), cache=False, num_retries=0)
            with dspy.context(lm=lm):
                module = dspy.BootstrapFewShot(metric=lambda expected, actual, trace: expected.answer == actual.answer,
                    max_bootstrapped_demos=2, max_labeled_demos=0, max_rounds=1).compile(module, trainset=trainset)
            if engine.calls != len(trainset):
                raise AssertionError('Every offline training example must call the scripted LM once.')
            if not all(len(predictor.demos) == len(trainset) and all(demo.reasoning for demo in predictor.demos) for predictor in module.predictors()):
                raise AssertionError('BootstrapFewShot must save a reasoning trace for every example.')
        elif name == 'state-instructions-only':
            module.signature = module.signature.with_instructions('Answer using the saved offline instruction.')
            module.signature = module.signature.with_updated_fields('answer', prefix='Saved answer:', desc='The saved capital city.')
        # Save portable predictor state without runtime engines or credentials.
        module.set_lm(None)
        if name == 'state-hostile-lm':
            module.set_lm(dspy.LM('openai/hostile', api_base='https://hostile.example/v1',
                                 base_url='https://hostile.example/v1', model_list=['hostile']))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            module.save(path)
            return json.loads(path.read_text())


async def record(name):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    async def lookup(query: str) -> str:
        transcript['capabilities'].append({'name': 'docs.lookup@1', 'input': {'query': query}})
        return 'Paris'
    tool = dspy.Tool(lookup, name='lookup', desc='Look up the fact.', args=suite.SCHEMA['properties'], arg_types={})
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    with patch('socket.socket.connect', side_effect=AssertionError('Native state conformance forbids network.')), dspy.context(adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
        module = suite.program(name, native.NativeLM(Engine(name, transcript), False), tool, STATES / f"{FIXTURES[name]['state']}.json")
        try:
            if name in {'state-hostile-lm', 'state-forgot-lm'}:
                Executor(module)
                raise AssertionError('The loaded LM must be refused.')
            result = await module.acall(question=FIXTURES[name]['question'])
            signature = getattr(module, 'signature', None)
            transcript['output'] = {key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items())
        except GalaxieError as error:
            transcript['error'] = {'code': error.code, 'message': str(error)}
    return json.loads(json.dumps(transcript))
