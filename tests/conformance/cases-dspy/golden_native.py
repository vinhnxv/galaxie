# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Independent plain-DSPy twins for runtime and retrieval golden families."""

import importlib.util
import json
from pathlib import Path
import sys
from typing import Any
from unittest.mock import patch

import dspy
from dspy.dsp.utils import dotdict

spec = importlib.util.spec_from_file_location('dspy_golden_reference', Path(__file__).with_name('native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The native DSPy reference cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)

RUNTIME = json.loads(Path(__file__).with_name('runtime-golden-cases.json').read_text())
RETRIEVAL = json.loads(Path(__file__).with_name('retrieval-golden-cases.json').read_text())
RUNTIME_PROBES = json.loads(Path(__file__).with_name('runtime-fixtures.json').read_text())
PROVIDER_PROBES = json.loads(Path(__file__).with_name('provider-fixtures.json').read_text())


class Engine(native.ReplayEngine):
    def __init__(self, name, reference, case):
        self.name, self.reference = name, reference
        self.replies = iter(case.get('replies', []))


class RuntimeTwin(dspy.Module):
    def __init__(self, name, lm, interaction):
        super().__init__()
        self.name, self.lm, self.interaction = name, lm, interaction
        self.predict = dspy.Predict('question: str -> answer: str')
        self.predict.set_lm(lm)

    async def aforward(self, question):
        trainset = [dspy.Example(**row).with_inputs('question') for row in RUNTIME_PROBES['trainset']]
        compiled = dspy.LabeledFewShot(k=2).compile(self.predict, trainset=trainset)
        compiled.set_lm(self.lm)
        first = await compiled.acall(question=question)
        demos = [{'question': demo.question, 'answer': demo.answer} for demo in compiled.demos]
        if self.name == 'rt-opt-labeled-two-stage':
            submission = self.interaction({
                'surfaceId': 'main', 'viewRevision': 'runtime',
                'component': 'test.Review/v1', 'props': {'answer': first.answer},
            })
            last = await compiled.acall(question=submission['payload'])
            return dspy.Prediction(first=first.answer, answer=last.answer, demos=demos)
        return dspy.Prediction(answer=first.answer, demos=demos)


class LocalRM:
    def __call__(self, query, k):
        passages = PROVIDER_PROBES['predictions']['P14']['output']['passages']
        return [dotdict(long_text=value) for value in passages[:k]]


class RetrievalTwin(dspy.Module):
    def __init__(self, lm, search):
        super().__init__()
        self.predict = dspy.Predict('question: str, passages: str -> answer: str')
        self.predict.set_lm(lm)
        self.search = search

    async def aforward(self, question, mode):
        result = await self.search({'query': question, 'mode': mode, 'k': 10})
        passages = result['passages']
        reply = await self.predict.acall(question=question, passages=json.dumps(passages, ensure_ascii=False))
        return dspy.Prediction(answer=reply.answer, passages=passages)


async def record(name, case, runtime):
    transcript = {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [], 'output': None, 'error': None}
    if case.get('resumes'):
        transcript['events'] = []
    reference = native.ReferenceReplay(transcript)
    engine = Engine(name, reference, case)

    async def search(value):
        capability = case['capability']
        entry, replayed = reference.call('capability', {'name': capability['name'], 'input': value})
        if not replayed:
            transcript['capabilities'].append({'name': capability['name'], 'input': value})
            entry['reply'] = capability['result']
        return entry['reply']

    answers = iter(case.get('resumes', []))
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    try:
        with patch('socket.socket.connect', side_effect=AssertionError('Native golden conformance forbids network.')), dspy.context(
            adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[],
        ):
            if name == 'pe-retrieve-colbert':
                # The provider probe measures rejected transport separately. Pin only its fixed public error.
                raise native.Termination('executor_error')
            if name == 'pe-retrieve-local-rm':
                with dspy.context(rm=LocalRM()):
                    result: Any = dspy.Retrieve(k=2)('RESTORED_INPUT_SECRET')
                transcript['output'] = dict(result.items())
            else:
                lm = native.ReplayLM(engine)
                module = RuntimeTwin(name, lm, reference.interaction) if runtime else RetrievalTwin(lm, search)
                while True:
                    try:
                        result = await module.acall(**case['input'])
                        reference.frontier()
                        transcript['output'] = dict(result.items())
                        break
                    except BaseException as error:
                        pause = native.pause_failure(error)
                        reference.frontier()
                        transcript['interactions'].append(pause.value)
                        transcript['events'].append({'mode': 'updates', 'data': {'kind': 'pause'}})
                        reference.entries[-1]['reply'] = next(answers)
                        reference.restart()
    except BaseException as error:
        candidate = getattr(error, 'code', None)
        code = candidate if isinstance(error, (native.Failure, native.Termination)) and candidate in native.ERRORS else 'executor_error'
        transcript['error'] = {'code': code, 'message': native.ERRORS[code]}
    return json.loads(json.dumps(transcript))


async def record_runtime(name):
    return await record(name, RUNTIME[name], True)


async def record_retrieval(name):
    return await record(name, RETRIEVAL[name], False)
