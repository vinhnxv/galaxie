# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from google.adk.agents import LlmAgent
from pydantic import BaseModel

CASES = (
    'plain-text', 'capability', 'sequential-tools', 'output-schema',
    'capability-denial', 'argument-block', 'step-budget', 'abort',
    'stream-text', 'stream-tools', 'stream-mid-block', 'stream-abort',
)
PARAMETERS = {
    'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'],
    'additionalProperties': False,
}
TOOL_CASES = (
    'capability', 'sequential-tools', 'capability-denial', 'argument-block', 'step-budget', 'stream-tools',
)


class Answer(BaseModel):
    value: int


def factory(name, model=None, tool=None):
    """The case's agent; the native lane passes its own model and tool, the Worker lane the host helpers."""
    if name not in CASES:
        raise ValueError('The conformance case is unknown.')
    if model is None:
        from galaxie.adk import capability_tool, llm
        model = llm('answer')
        tool = capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.')
    options = {'output_schema': Answer, 'output_key': 'result'} if name == 'output-schema' else {}
    return LlmAgent(
        name='conformance', model=model, instruction='Use the supplied tools and answer briefly.',
        tools=[tool] if name in TOOL_CASES and tool is not None else [], **options,
    )
