# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Load optimizer JSON with the unchanged offline-state author recipe."""

from pathlib import Path
from typing import Any

import dspy


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


SCHEMA = {'type': 'object', 'properties': {'question': {'type': 'string'}}, 'required': ['question'], 'additionalProperties': False}


def build(name) -> Any:
    return dspy.Predict(Question)


def program(name, lm, state_path):
    module = build(name)
    module.load(state_path)
    if name != 'optstate-forgot-lm':
        module.set_lm(lm)
    return module


def factory(name):
    from galaxie.dspy import Executor, GalaxieLM
    return Executor(program(name, GalaxieLM('answer'), Path(__file__).with_name('state.json')),
                    adapter=dspy.ChatAdapter(use_json_adapter_fallback=False))
