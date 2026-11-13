# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Scripted fan-out programs shared by native and Worker spike lanes."""

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
import threading
from typing import Any

import dspy
from dspy.dsp.utils.settings import dotdict, thread_local_overrides
from galaxie.dspy import Executor, GalaxieLM, capability_tool, request_interaction

LABELS = ('alpha', 'beta', 'gamma')
SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}


def model_question(messages: list[dict[str, Any]]) -> str:
    text = next(message['content'] for message in reversed(messages) if message['role'] == 'user')
    return text.split('[[ ## question ## ]]\n', 1)[1].split('\n\n', 1)[0].strip()


def reply_text(question: str) -> str:
    return f'[[ ## answer ## ]]\n{question}\n[[ ## completed ## ]]'


def review(revision: str) -> dict[str, Any]:
    return request_interaction({'surfaceId': 'main', 'viewRevision': revision, 'component': 'test.Review/v1', 'props': {}})


def thread_probe() -> dict[str, str]:
    results = {}
    try:
        thread = threading.Thread(target=lambda: None)
        thread.start()
        thread.join()
        results['thread'] = 'started'
    except Exception as error:
        results['thread'] = type(error).__name__
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(lambda: None).result()
        results['pool'] = 'started'
    except Exception as error:
        results['pool'] = type(error).__name__
    return results


def program(name: str, *, lm: Any = None, tool: Any = None, interaction: Any = None, candidate: bool = False, changed: bool | str = False) -> dspy.Module:
    lm = GalaxieLM('answer') if lm is None else lm
    tool = capability_tool('docs.lookup@1', 'Record a branch write.', SCHEMA) if tool is None else tool
    pause = review if interaction is None else interaction

    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(lm)

        async def fan(self, shape: str, stage: str, labels: tuple[str, ...] = LABELS) -> list[Any]:
            if changed == 'removed' and stage == 'before':
                labels = tuple(label for label in labels if label != 'gamma')

            async def branch(label: str) -> Any:
                query = f'{label}:{stage}'
                question = query + (':changed' if changed is True and label == 'alpha' and stage == 'before' else '')
                if shape == 'write':
                    return await tool.acall(query=query)
                first = await self.predict.acall(question=question)
                if shape == 'multi':
                    receipt = await tool.acall(query=query)
                    last = await self.predict.acall(question=f'{label}:last-{stage}')
                    return {'first': first.answer, 'receipt': receipt, 'answer': last.answer}
                return first.answer

            if candidate:
                from parallel_candidate import branches
                return list((await branches({f'{stage}.{label}': lambda label=label: branch(label) for label in labels})).values())
            return list(await asyncio.gather(*(branch(label) for label in labels)))

        async def aforward(self, question: str) -> dspy.Prediction:
            if name == 'par-verbatim-thread-start':
                return dspy.Prediction(**thread_probe())
            if name == 'par-refuse-bare-context':
                return await asyncio.create_task(self.predict.acall(question=question), context=contextvars.Context())
            if name == 'par-wrapped-thread-start':
                try:
                    thread = threading.Thread(target=lambda: None)
                    thread.start()
                    thread.join()
                except RuntimeError as error:
                    raise ValueError('Author thread wrapper.') from error
                return dspy.Prediction(answers=['started'])
            if name == 'par-refuse-context':
                parent = thread_local_overrides.get().copy()
                def worker():
                    thread_local_overrides.set(dotdict({**thread_local_overrides.get(), **parent}))
                    return self.predict(question=question)
                try:
                    contextvars.Context().run(worker)
                except BaseException:
                    return dspy.Prediction(answers=['fallback'])
            if name.startswith('par-verbatim-'):
                threads = 1 if name.endswith('sequential') else 3
                examples = [dspy.Example(question=f'{label}:before', answer=f'{label}:before').with_inputs('question') for label in LABELS]
                if 'parallel-' in name:
                    results = dspy.Parallel(num_threads=threads, disable_progress_bar=True)([(self.predict, example) for example in examples])
                    return dspy.Prediction(answers=[None if item is None else item.answer for item in results])
                result = dspy.Evaluate(devset=examples, num_threads=threads, display_progress=False, display_table=False)(self.predict, metric=lambda example, prediction: float(prediction.answer == example.answer))
                return dspy.Prediction(score=result.score, answers=[dict(prediction.items()) for _, prediction, _ in result.results])
            if name == 'par-fan-concurrent-pauses':
                async def ask(label: str) -> Any:
                    return pause(label)
                if candidate:
                    from parallel_candidate import branches
                    await branches({label: lambda label=label: ask(label) for label in LABELS[:2]})
                else:
                    results = await asyncio.gather(*(ask(label) for label in LABELS[:2]), return_exceptions=True)
                    raise BaseExceptionGroup('Concurrent interactions.', [result for result in results if isinstance(result, BaseException)])
            if name == 'par-fan-pause-in-branch':
                async def model() -> Any:
                    return await self.predict.acall(question='alpha:before')
                async def ask_inside() -> Any:
                    return pause('inside')
                if candidate:
                    from parallel_candidate import branches
                    await branches({'alpha': model, 'beta': ask_inside})
                else:
                    await asyncio.gather(model(), ask_inside())
                return dspy.Prediction(answers=[])
            if name == 'par-fan-eval-loop':
                labels = (*LABELS, 'delta')
                answers = await self.fan('single', 'before', labels)
                if question == 'reload':
                    pause('evaluated')
                scores = [float(answer == f'{label}:before') for label, answer in zip(labels, answers, strict=True)]
                return dspy.Prediction(answers=answers, score=100 * sum(scores) / len(scores))
            shape = 'multi' if name.endswith('multi') else 'write' if name == 'par-fan-write' else 'single'
            if name in {'par-fan-write', 'par-fan-multi'}:
                pause('start')
            before = await self.fan(shape, 'before')
            if 'two-stage-' in name or name == 'par-fan-diverge':
                pause('joined')
                answers = await self.fan(shape, 'after')
                return dspy.Prediction(before=before, answers=answers)
            return dspy.Prediction(answers=before)

    return Program()


def factory(name: str, candidate: bool = False, changed: bool | str = False) -> Executor:
    return Executor(program(name, candidate=candidate, changed=changed))
