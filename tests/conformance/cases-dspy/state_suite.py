# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""JSON state programs shared by CPython and the Pyodide Worker."""

import copy
import json
from pathlib import Path
import time
from typing import Any

import dspy
from dspy.utils.saving import get_dependency_versions
from pydantic import BaseModel


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}


def build(name, tool=None) -> Any:
    if name == 'state-chain-of-thought-bootstrap':
        return dspy.ChainOfThought(Question)
    if name == 'state-react-demos':
        if tool is None:
            from galaxie.dspy import capability_tool
            tool = capability_tool('docs.lookup@1', 'Look up the fact.', SCHEMA, tool_name='lookup')
        return dspy.ReAct(Question, tools=[tool], max_iters=1)
    return dspy.Predict(Question)


def exception_name(action):
    try:
        action()
    except Exception as error:
        return type(error).__name__
    raise AssertionError('The catalog action should have been refused.')


def catalog(state_path):
    state = json.loads(state_path.read_text())
    predict = dspy.Predict(Question, temperature=0.25)
    predict.load(state_path)
    custom = copy.deepcopy(state)
    custom['lm'] = {'_dspy_lm_class': 'galaxie.dspy.GalaxieLM', 'model': 'answer'}

    class Pair(dspy.Module):
        def __init__(self):
            self.first = dspy.Predict(Question)
            self.second = dspy.Predict(Question)

    pair = Pair()
    before = copy.deepcopy(pair.dump_state())
    missing = pair.dump_state()
    missing['first']['demos'] = [{'question': 'Changed', 'answer': 'Changed'}]
    del missing['second']
    missing_error = exception_name(lambda: pair.load_state(missing))
    extra = pair.dump_state()
    extra['ignored'] = {'anything': True}
    pair.load_state(extra)

    class Reordered(dspy.Signature):
        second: str = dspy.InputField()
        first: str = dspy.InputField()
        answer: str = dspy.OutputField()

    from dspy.signatures import make_signature
    signature: Any = make_signature('first, second -> answer')
    signature = signature.with_updated_fields('first', prefix='First saved:', desc='First saved description')
    signature = signature.with_updated_fields('second', prefix='Second saved:', desc='Second saved description')
    reordered: Any = Reordered.load_state(signature.dump_state())

    class Fact(BaseModel):
        city: str

    typed = dspy.Predict(Question)
    typed.demos = [dspy.Example(question='France', answer=Fact(city='Paris'))]
    plain = dspy.Predict(Question)
    plain.load_state(json.loads(json.dumps(typed.dump_state())))
    # State restores predictors, not the executable tool functions or max_iters.
    async def original(query: str) -> str:
        return 'Original'
    async def replacement(query: str) -> str:
        return 'Replacement'
    def react(function, count) -> Any:
        tool = dspy.Tool(function, name='lookup', desc='Look up the fact.', args=SCHEMA['properties'], arg_types={})
        return dspy.ReAct(Question, tools=[tool], max_iters=count)
    old = react(original, 1)
    new = react(replacement, 3)
    new.load_state(old.dump_state())
    return {
        'pickle': exception_name(lambda: predict.load(state_path.with_suffix('.pkl'))),
        'customLm': exception_name(lambda: dspy.Predict(Question).load_state(custom)),
        'missingKey': missing_error,
        'missingKeyUnchanged': pair.dump_state() == before,
        'extraKeyIgnored': not hasattr(pair, 'ignored'),
        'reorderedFields': {name: field.json_schema_extra for name, field in reordered.fields.items()},
        'demoType': type(predict.demos[0]).__name__,
        'demoValueType': type(plain.demos[0]['answer']).__name__,
        'config': predict.config,
        'lmRestored': predict.lm is not None,
        'toolPreserved': new.tools['lookup'].func is replacement,
        'maxIters': new.max_iters,
        'versionsMatch': state['metadata']['dependency_versions'] == get_dependency_versions(),
    }


class Catalog(dspy.Module):
    def __init__(self, state_path):
        self.predict = dspy.Predict(Question)
        self.state_path = state_path

    async def aforward(self, question):
        return dspy.Prediction(**catalog(self.state_path))


class Limits(dspy.Module):
    def __init__(self, state_path):
        self.predict = dspy.Predict(Question)
        started = time.perf_counter()
        self.predict.load(state_path)
        self.load_ms = (time.perf_counter() - started) * 1000

    async def aforward(self, question):
        result = await self.predict.acall(question=question)
        return dspy.Prediction(answer=result.answer, demos=len(self.predict.demos), loadMs=self.load_ms)


def program(name, lm, tool, state_path):
    if name == 'state-roundtrip-catalog':
        module = Catalog(state_path)
    elif name == 'state-limits':
        module = Limits(state_path)
    else:
        module = build(name, tool)
        module.load(state_path)
    if name not in {'state-hostile-lm', 'state-forgot-lm'}:
        module.set_lm(lm)
    return module


def factory(name):
    from galaxie.dspy import Executor, GalaxieLM
    return Executor(program(name, GalaxieLM('answer'), None, Path(__file__).with_name('state.json')),
                    adapter=dspy.ChatAdapter(use_json_adapter_fallback=False))
