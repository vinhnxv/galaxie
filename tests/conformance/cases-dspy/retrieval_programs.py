# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Host-bound passage retrieval with the RAG example's capability contract."""

import json

import dspy
from galaxie.capabilities import call
from galaxie.dspy import Executor, GalaxieLM


class Rag(dspy.Module):
    def __init__(self):
        super().__init__()
        self.predict = dspy.Predict('question: str, passages: str -> answer: str')
        self.predict.set_lm(GalaxieLM('rag.answer'))

    async def aforward(self, question, mode):
        result = await call('docs.search@1', {'query': question, 'mode': mode, 'k': 10})
        passages = result['passages']
        reply = await self.predict.acall(question=question, passages=json.dumps(passages, ensure_ascii=False))
        return dspy.Prediction(answer=reply.answer, passages=passages)


def create_agent():
    return Executor(Rag(), adapter=dspy.ChatAdapter(use_json_adapter_fallback=False))
