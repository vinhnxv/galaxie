# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from pydantic import BaseModel

CASES = (
    'plain-text', 'capability', 'sequential-tools', 'output-schema',
    'capability-denial', 'argument-block', 'step-budget', 'abort',
    'stream-text', 'stream-tools', 'stream-mid-block', 'stream-abort',
    'confirm-approve', 'confirm-deny', 'confirm-two', 'long-running', 'confirm-stale',
    'confirm-incomplete', 'confirm-double-submit', 'confirm-consecutive', 'stream-confirm-approve',
    'agents-sequential', 'agents-parallel', 'agents-loop', 'agents-transfer', 'stream-agents-sequential',
    'agents-confirm-last',
)
# Cases whose agent tree has several agents; the scripted model answers by agent name.
SHAPES = (
    'agents-sequential', 'agents-parallel', 'agents-loop', 'agents-transfer', 'stream-agents-sequential',
    'agents-confirm-last',
)
CONFIRMATION_CASES = tuple(name for name in CASES if 'confirm' in name)
INTERACTION_CASES = (*CONFIRMATION_CASES, 'long-running')
PARAMETERS = {
    'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'],
    'additionalProperties': False,
}
TOOL_CASES = (
    'capability', 'sequential-tools', 'capability-denial', 'argument-block', 'step-budget', 'stream-tools',
    *INTERACTION_CASES,
)


class Answer(BaseModel):
    value: int


def interaction(requests):
    """What the host shows for the paused calls; both lanes use this projection."""
    return {'surfaceId': 'main', 'viewRevision': 'confirm-1', 'component': 'tests.Approval/v1', 'props': {'requests': requests}}


def external_answer(requests, action, payload):
    """The author's resume for a long-running call: the submitted payload is the call's result."""
    return [{'response': payload} for _ in requests]


def hooks(name):
    """The author hooks of an interaction case; the native lane applies them itself."""
    return {'interaction': interaction, **({'resume': external_answer} if name == 'long-running' else {})}


def shape(name, model, tool):
    """The supported multi-agent trees, each over the host's model and one capability tool."""

    def leaf(agent, tools=(), **options):
        return LlmAgent(
            name=agent, model=model, description=f'The {agent} agent.', instruction=f'Answer as {agent}.',
            tools=list(tools), **options,
        )

    kind = name.removeprefix('stream-')
    if kind == 'agents-sequential':
        return SequentialAgent(name='pipeline', sub_agents=[leaf('drafter', [tool]), leaf('reviewer')])
    if kind == 'agents-parallel':
        # The merger sees the last branch event, so the fixtures gate right's answer behind left's in both lanes.
        fanout = ParallelAgent(name='fanout', sub_agents=[leaf('left', [tool]), leaf('right', [tool])])
        return SequentialAgent(name='pipeline', sub_agents=[fanout, leaf('merger', include_contents='none')])
    if kind == 'agents-loop':
        return LoopAgent(name='refine', max_iterations=2, sub_agents=[leaf('worker', [tool])])
    if kind == 'agents-transfer':
        return LlmAgent(
            name='router', model=model, description='The router agent.', instruction='Route the request.',
            sub_agents=[leaf('specialist', [tool])],
        )
    if kind == 'agents-confirm-last':
        return SequentialAgent(name='pipeline', sub_agents=[leaf('drafter'), leaf('approver', [tool])])
    raise ValueError('The conformance case is unknown.')


def factory(name, model=None, tool=None):
    """The case's agent; the native lane passes its own model and tool, the Worker lane the host helpers."""
    if name not in CASES:
        raise ValueError('The conformance case is unknown.')
    worker = model is None
    if worker:
        from galaxie.adk import capability_tool, llm
        model = llm('answer')
        tool = capability_tool(
            'double', 'math.double@1', PARAMETERS, 'Double an integer.',
            require_confirmation=name in CONFIRMATION_CASES, long_running=name == 'long-running',
        )
    options = {'output_schema': Answer, 'output_key': 'result'} if name == 'output-schema' else {}
    agent = shape(name, model, tool) if name in SHAPES else LlmAgent(
        name='conformance', model=model, instruction='Use the supplied tools and answer briefly.',
        tools=[tool] if name in TOOL_CASES and tool is not None else [], **options,
    )
    if worker and name in INTERACTION_CASES:
        from galaxie.adk import Executor
        return Executor(agent, **hooks(name))
    return agent
