# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""The same DSPy programs run natively and through the Worker adapter."""

import dspy
from typing import Any


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}


def base_name(name):
    return {
        'stream-text': 'chain-of-thought', 'stream-fragmented': 'chain-of-thought',
        'stream-tools': 'react-one-tool', 'stream-native-tools': 'native-tool-calling',
        'stream-mid-block': 'predict', 'stream-final-mismatch': 'predict',
        'stream-abort': 'abort', 'stream-json-adapter': 'json-adapter',
        'stream-outcome-unknown': 'outcome-unknown', 'stream-argument-block': 'argument-block',
        'stream-literal-brackets': 'predict', 'stream-literal-fragmented': 'predict',
        'stream-repeat': 'repeat',
    }.get(name, name)


def program(name, lm=None, tool=None):
    streaming = name.startswith('stream-')
    name = base_name(name)
    if lm is None:
        from galaxie.dspy import GalaxieLM
        lm = GalaxieLM('answer', native_tools=name in {'native-tool-calling', 'argument-block'})
    if name in {'react-one-tool', 'react-two-tools', 'react-v2', 'native-tool-calling', 'argument-block', 'capability-denial', 'outcome-unknown'}:
        if tool is None:
            from galaxie.dspy import capability_tool
            tool = capability_tool('docs.lookup@1', 'Look up the fact.', SCHEMA, tool_name='lookup')
        if name in {'react-v2', 'native-tool-calling', 'argument-block'}:
            module = dspy.ReActV2(Question, tools=[tool], max_iters=2)
        else:
            module = dspy.ReAct(Question, tools=[tool], max_iters=2 if name == 'react-two-tools' else 1)
    elif name == 'chain-of-thought':
        module = dspy.ChainOfThought(Question)
    elif name == 'repeat':
        class Refine(dspy.Module):
            def __init__(self):
                self.predict = dspy.Predict(Question)
            async def aforward(self, question):
                await self.predict.acall(question=question)
                return await self.predict.acall(question=question)
        module = Refine()
    else:
        module = dspy.Predict(Question)
    module.set_lm(dspy.LM('openai/x') if name == 'refused-lm' else lm)
    if streaming and name in {'native-tool-calling', 'argument-block'}:
        react: Any = getattr(module, 'react')
        react.signature = react.signature.with_updated_fields('next_thought', type_=str)
    return module


def factory(name):
    from galaxie.dspy import Executor
    base = base_name(name)
    adapter = dspy.JSONAdapter() if base == 'json-adapter' else dspy.ChatAdapter(use_json_adapter_fallback=False, use_native_function_calling=base in {'native-tool-calling', 'argument-block'})
    if name == 'stream-final-mismatch':
        import galaxie.dspy as face
        original = face.request
        async def mismatched_reply(*args, **kwargs):
            face.request = original
            value = await original(*args, **kwargs)
            return {**value, 'content': value['content'] + ' changed'}
        face.request = mismatched_reply
    if name.startswith('stream-'):
        import dspy.streaming.messages as status
        def threaded_status(*args):
            raise BaseException('Streaming used the threaded status sender.')
        status.sync_send_to_stream = threaded_status
    fields = ['next_thought'] if base in {'native-tool-calling', 'argument-block'} else ['answer']
    return Executor(program(name), adapter=adapter, stream_fields=fields if name.startswith('stream-') else [])
