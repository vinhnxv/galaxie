# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from pydantic import BaseModel
from pydantic_ai import Agent, PromptedOutput

from galaxie.pydantic_ai import GalaxieModel, capability_tool

CASES = (
    'plain-text', 'capability', 'sequential-tools', 'tool-output', 'output-retry',
    'prompted-output', 'capability-denial', 'argument-block', 'abort',
)
PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'], 'additionalProperties': False}


class Answer(BaseModel):
    value: int


def factory(name, model=None):
    if name not in CASES:
        raise ValueError('The conformance case is unknown.')
    tool = capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.')
    tools = [tool] if name in ('capability', 'sequential-tools', 'capability-denial', 'argument-block') else []
    output_type = PromptedOutput(Answer) if name == 'prompted-output' else Answer if name in ('tool-output', 'output-retry') else str
    return Agent(
        model or GalaxieModel('answer'), output_type=output_type, tools=tools,
        instructions='Use the supplied tools and answer briefly.', system_prompt='You are a deterministic fixture.',
        retries=1, name='conformance',
    )
