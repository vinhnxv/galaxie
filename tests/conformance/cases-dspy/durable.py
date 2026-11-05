# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Deterministic programs shared by the durable DSPy lanes."""

import dspy
from galaxie import capabilities
from galaxie.dspy import Executor, GalaxieLM, request_interaction

PRIVATE_INPUT = 'RESTORED_INPUT_SECRET'
PRIVATE_RESULT = 'RESTORED_CAPABILITY_SECRET'


def factory(name, changed=False):
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            receipt = None
            if name == 'durable-model-replay':
                await self.predict.acall(question=question)
            if name != 'durable-frontier-write':
                receipt = await capabilities.call('docs.lookup@1', {'query': 'before'})
            if name in {'durable-url-input', 'durable-url-result'}:
                assert receipt is not None
                secret = question if name.endswith('input') else receipt
                request_interaction({'surfaceId': 'main', 'viewRevision': 'url', 'component': 'test.Review/v1', 'props': {'href': 'https://allowed.example/?value=' + secret}})
            first = request_interaction({'surfaceId': 'main', 'viewRevision': 'first', 'component': 'test.Review/v1', 'props': {'receipt': receipt, **({'passages': 'p' * 200000} if name == 'durable-large-pauses' else {})}})
            if name in {'durable-two', 'durable-large-pauses'}:
                first = request_interaction({'surfaceId': 'main', 'viewRevision': 'second', 'component': 'test.Review/v1', 'props': {'answer': first['payload'], **({'passages': 'q' * 200000} if name == 'durable-large-pauses' else {})}})
            if name == 'durable-frontier-write':
                receipt = await capabilities.call('docs.lookup@1', {'query': 'changed' if changed else 'after'})
            if name == 'durable-oversize-completion':
                # Each result fits the bridge; their completed journal does not.
                for index in range(3):
                    await capabilities.call('docs.lookup@1', {'query': f'large-{index}'})
            result = await self.predict.acall(question=first['payload'])
            if name in {'durable-private-input', 'durable-private-result'}:
                await capabilities.call('outbound@1', {'query': question if name.endswith('input') else receipt})
            return dspy.Prediction(answer=result.answer, receipt=receipt)
    return Executor(Program())
