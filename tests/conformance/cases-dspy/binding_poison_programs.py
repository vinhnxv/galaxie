# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Shared sequential programs for poison and editable Python-data measurements."""

import dspy
from galaxie import capabilities
from galaxie.dspy import Executor, GalaxieLM, request_interaction


def create_agent(variant='original'):
    catalog = __import__('catalog') if variant in ('data', 'data-request') else None

    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            if variant != 'removed':
                query = catalog.VALUE if catalog is not None and variant == 'data-request' else 'changed' if variant == 'changed' else 'before'
                await capabilities.call('docs.lookup@1', {'query': query})
            request_interaction({'surfaceId': 'main', 'viewRevision': 'first', 'component': 'test.Review/v1', 'props': {}})
            await capabilities.call('docs.lookup@1', {'query': 'after'})
            result = await self.predict.acall(question=question)
            return {'answer': result.answer, 'catalog': catalog.VALUE} if catalog is not None else result

    return Executor(Program())
