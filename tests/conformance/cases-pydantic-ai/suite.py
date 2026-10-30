# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from pydantic import BaseModel
from pydantic_ai import Agent, PromptedOutput

from galaxie.pydantic_ai import GalaxieModel, capability_tool

CASES = (
    'plain-text', 'capability', 'sequential-tools', 'tool-output', 'output-retry',
    'prompted-output', 'capability-denial', 'argument-block', 'abort',
    'stream-text', 'stream-tools', 'stream-tool-output', 'stream-output-retry',
    'stream-id-block', 'stream-mid-block', 'stream-final-mismatch', 'stream-abort',
)
PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'], 'additionalProperties': False}


class Answer(BaseModel):
    value: int


def factory(name, model=None):
    if name not in CASES:
        raise ValueError('The conformance case is unknown.')
    tool = capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.')
    tools = [tool] if name in ('capability', 'sequential-tools', 'capability-denial', 'argument-block', 'stream-tools', 'stream-id-block') else []
    output_type = PromptedOutput(Answer) if name == 'prompted-output' else Answer if name in ('tool-output', 'output-retry', 'stream-tool-output', 'stream-output-retry') else str
    if name == 'stream-final-mismatch' and model is None:
        import galaxie.pydantic_ai as face
        original = face.request

        async def mismatched_reply(*args, **kwargs):
            # One-shot patch: restore the bridge request so a reused runtime is unaffected.
            face.request = original
            value = await original(*args, **kwargs)
            return {**value, 'content': value['content'] + ' changed'}

        face.request = mismatched_reply
    return Agent(
        model or GalaxieModel('answer'), output_type=output_type, tools=tools,
        instructions='Use the supplied tools and answer briefly.', system_prompt='You are a deterministic fixture.',
        retries=1, name='conformance',
    )
