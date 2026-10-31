# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""The same DSPy programs run natively and through the Worker adapter."""

import dspy


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}


def program(name, lm=None, tool=None):
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
    else:
        module = dspy.Predict(Question)
    module.set_lm(dspy.LM('openai/x') if name == 'refused-lm' else lm)
    return module


def factory(name):
    from galaxie.dspy import Executor
    adapter = dspy.JSONAdapter() if name == 'json-adapter' else dspy.ChatAdapter(use_json_adapter_fallback=False, use_native_function_calling=name in {'native-tool-calling', 'argument-block'})
    return Executor(program(name), adapter=adapter)
