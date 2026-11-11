# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Verbatim DSPy sync and runtime-optimizer shapes; shared by both spike lanes."""

import asyncio

import dspy
from galaxie.dspy import Executor, GalaxieLM, request_interaction

PROGRAMS = (
    'rt-sync-forward-only', 'rt-sync-module-call', 'rt-sync-forward-call',
    'rt-sync-lm-call', 'rt-sync-swallowed', 'rt-sync-to-thread',
    'rt-sync-acall-control', 'rt-opt-bootstrap', 'rt-opt-mipro', 'rt-opt-copro',
    'rt-opt-gepa', 'rt-opt-labeled', 'rt-opt-labeled-naive',
    'rt-opt-labeled-two-stage',
)
TRAINSET = [
    dspy.Example(question='Capital of France?', answer='Paris').with_inputs('question'),
    dspy.Example(question='Capital of Japan?', answer='Tokyo').with_inputs('question'),
    dspy.Example(question='Capital of Italy?', answer='Rome').with_inputs('question'),
]
FORWARD_CALLS = 0


def demos_of(predictor):
    return [{'question': demo.question, 'answer': demo.answer} for demo in predictor.demos]


def metric(example, prediction, trace=None):
    return float(example.answer == prediction.answer)


def gepa_metric(example, prediction, trace=None, pred_name=None, pred_trace=None):
    return metric(example, prediction, trace)


class ForwardOnly(dspy.Module):
    def forward(self, question):
        global FORWARD_CALLS
        FORWARD_CALLS += 1
        raise AssertionError('Sync-only author body must never execute.')


class SyncInner(dspy.Module):
    def __init__(self):
        self.predict = dspy.Predict('question: str -> answer: str')
        self.predict.set_lm(GalaxieLM('answer'))

    def forward(self, question):
        return self.predict(question=question)


class RuntimeProgram(dspy.Module):
    def __init__(self, name):
        self.name = name
        self.predict = dspy.Predict('question: str -> answer: str')
        self.predict.set_lm(GalaxieLM('answer'))
        if name == 'rt-sync-forward-call':
            self.inner = SyncInner()

    async def aforward(self, question):
        name = self.name
        if name == 'rt-sync-module-call':
            return self.predict(question=question)
        if name == 'rt-sync-forward-call':
            return self.inner.forward(question=question)
        if name == 'rt-sync-lm-call':
            return GalaxieLM('answer')('q')
        if name == 'rt-sync-swallowed':
            try:
                return self.predict(question=question)
            except Exception:
                return dspy.Prediction(answer='fallback')
        if name == 'rt-sync-to-thread':
            return await asyncio.to_thread(self.predict, question=question)
        if name == 'rt-sync-acall-control':
            return await self.predict.acall(question=question)
        if name == 'rt-opt-bootstrap':
            compiled = dspy.BootstrapFewShot(
                metric=metric, max_bootstrapped_demos=1, max_labeled_demos=0,
                max_rounds=1, max_errors=3,
            ).compile(self.predict, trainset=TRAINSET)
        elif name == 'rt-opt-mipro':
            lm = GalaxieLM('answer')
            compiled = dspy.MIPROv2(
                metric=metric, prompt_model=lm, task_model=lm, auto=None,
                num_candidates=2, num_threads=1, max_bootstrapped_demos=1,
                max_labeled_demos=0, max_errors=3,
            ).compile(self.predict, trainset=TRAINSET, valset=TRAINSET,
                      num_trials=1, minibatch=False)
        elif name == 'rt-opt-copro':
            compiled = dspy.COPRO(
                prompt_model=GalaxieLM('answer'), metric=metric, breadth=2, depth=1,
            ).compile(self.predict, trainset=TRAINSET,
                      eval_kwargs={'num_threads': 1, 'display_progress': False})
        elif name == 'rt-opt-gepa':
            compiled = dspy.GEPA(
                metric=gepa_metric, reflection_lm=GalaxieLM('answer'),
                max_metric_calls=3, num_threads=1,
            ).compile(self.predict, trainset=TRAINSET, valset=TRAINSET)
        else:
            compiled = dspy.LabeledFewShot(k=2).compile(self.predict, trainset=TRAINSET)
            if name != 'rt-opt-labeled-naive':
                compiled.set_lm(GalaxieLM('answer'))
            first = await compiled.acall(question=question)
            if name == 'rt-opt-labeled-two-stage':
                resumed = request_interaction({
                    'surfaceId': 'main', 'viewRevision': 'runtime',
                    'component': 'test.Review/v1', 'props': {'answer': first.answer},
                })
                last = await compiled.acall(question=resumed['payload'])
                return dspy.Prediction(first=first.answer, answer=last.answer, demos=demos_of(compiled))
            return dspy.Prediction(answer=first.answer, demos=demos_of(compiled))
        return await compiled.acall(question=question)


def factory(name):
    assert name in PROGRAMS
    return Executor(ForwardOnly() if name == 'rt-sync-forward-only' else RuntimeProgram(name))
