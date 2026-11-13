# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Shared scripted schema-output programs, with an explicitly supplied LM."""

from typing import Literal

import dspy
from galaxie.dspy import Executor, GalaxieLM, request_interaction
from pydantic import BaseModel, ConfigDict

QUESTION = 'Which answer?'
JSON_REPLY = '{"answer":"done"}'
CHAT_REPLY = '[[ ## answer ## ]]\ndone\n[[ ## completed ## ]]'
TOOL = {'type': 'function', 'function': {'name': 'lookup', 'description': 'Look up an answer.', 'parameters': {'type': 'object', 'properties': {}}}}


class LiteralAnswer(dspy.Signature):
    question: str = dspy.InputField()
    answer: Literal['done', 'other'] = dspy.OutputField()


class ChangedAnswer(dspy.Signature):
    question: str = dspy.InputField()
    answer: Literal['done', 'changed'] = dspy.OutputField()


class MappingAnswer(dspy.Signature):
    question: str = dspy.InputField()
    answer: dict[str, str] = dspy.OutputField()


class AnswerModel(BaseModel):
    model_config = ConfigDict(extra='forbid')
    answer: Literal['done', 'other']


def adapter_for(name):
    return dspy.ChatAdapter(use_json_adapter_fallback=False) if name in ('so-explicit-response-format', 'so-schema-tools-refused', 'so-stream-schema-refused') else dspy.JSONAdapter()


class Program(dspy.Module):
    def __init__(self, name, lm, *, pause=False, changed=False):
        super().__init__()
        self.name, self.pause = name, pause
        signature = MappingAnswer if name == 'so-json-object-refused' else ChangedAnswer if changed else LiteralAnswer
        config = {'response_format': AnswerModel} if isinstance(adapter_for(name), dspy.ChatAdapter) and not isinstance(adapter_for(name), dspy.JSONAdapter) else {}
        if name == 'so-schema-tools-refused':
            config['tools'] = [TOOL]
        self.predict = dspy.Predict(signature, **config)
        self.predict.set_lm(lm)

    async def aforward(self, question):
        result = await self.predict.acall(question=question)
        if self.pause:
            request_interaction({'surfaceId': 'main', 'viewRevision': 'schema', 'component': 'test.Review/v1', 'props': {'answer': result.answer}})
        return result


def factory(name, *, enabled=True, pause=False, changed=False):
    lm = GalaxieLM('answer', schema_output=enabled)
    return Executor(Program(name, lm, pause=pause, changed=changed), adapter=adapter_for(name),
                    stream_fields=('answer',) if name == 'so-stream-schema-refused' else ())
