# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Offline-state programs shared by the durable DSPy test lanes."""

import hashlib
from pathlib import Path
from typing import Any

import dspy
from galaxie import capabilities
from galaxie.dspy import Executor, GalaxieLM, request_interaction

PROGRAMS = ('state-durable-early-model', 'state-durable-late-model', 'state-durable-fingerprint')


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


def factory(name, state_path=None):
    assert name in PROGRAMS
    path = Path(state_path) if state_path is not None else Path(__file__).with_name('state.json')
    state_digest = hashlib.sha256(path.read_bytes()).hexdigest()

    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.load(path)
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            if name == 'state-durable-early-model':
                await self.predict.acall(question=question)
            receipt = await capabilities.call('docs.lookup@1', {'query': 'before'})
            props = {'receipt': receipt}
            if name == 'state-durable-fingerprint':
                props['stateDigest'] = state_digest
            first = request_interaction({'surfaceId': 'main', 'viewRevision': 'first', 'component': 'test.Review/v1', 'props': props})
            result = await self.predict.acall(question=first['payload'])
            signature: Any = self.predict.signature
            return dspy.Prediction(answer=result.answer, receipt=receipt, demos=len(self.predict.demos), instructions=signature.instructions)

    return Executor(Program())
