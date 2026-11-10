# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Delegation spike: fixed outcome rule, recorded before running probes.

Green tests pin observations; only the satisfaction conditions below decide outcomes.
An unmeasured P0 makes the affected gap undetermined. P1 is informational.

Gap 1 (plain delegation): P0 D1-D5, G1, G2. Supported requires all satisfied
for plain/usage with unchanged shipped source. Alternative requires D3 and all
D1-D5/G1/G2 satisfied by helper or flattening, after a plain/usage D2/D4/D5
failure; helper must fit one Python function without a core export/bridge change.
Refused if D3 fails or no variant satisfies D1-D5. Failed G1 caps a successful
helper at alternative by documentation; otherwise refused with no guard available.
Gap 2 (child pauses): P0 P1-P4. Supported requires no unapproved gated bodies
(P1/P2), and hoist completion/restore (P3/P4) in both applicable lanes.
Alternative requires P1/P2 and CPython P3, a Node P3/P4 failure, and passing
flatten probe F1 in both lanes. Otherwise refused. Any P1/P2 unapproved body
means unsafe as shipped and is reported first.
Gap 3 (subgraphs/paths): P0 S1. Supported only with stable child stream paths
and supported Gap 2; otherwise refused. Alternative never applies.

ID priority lanes satisfaction condition
D1 P0 N model/token/tool totals count parent plus child exactly once
D2 P0 C,N total bridged requests never exceed parent step limit
D3 P0 N private child data blocks forbidden destination before provider
D4 P0 C stable child scopes across runs, disjoint from parent scopes
D5 P0 N one write overall and identical effect ID after restore
D6 P1 C each native child starts repairAttempt at zero
D7 P1 N child deltas are checked and projected to host streams
D8 P1 C non-GalaxieModel child requests are visible to bridge
P1 P0 C excluded DeferredToolRequests never executes gated body
P2 P0 C,N returned deferral data never executes gated body
P3 P0 C,N hoisted approval completes child, gated body once
P4 P0 N restored hoist preserves pending interaction and writes once
P5 P1 C record parallel pending interactions
P6 P1 C extra answer fields and tampered child metadata are rejected
S1 P0 N child delta events carry a stable path across identical runs
S2 P1 C prepared executor reports subgraphs false
G1 P0 C public signals distinguish nested runs without top-level false positives
G2 P0 C,N guard raises unsupported before nested bridge model request
F1 P0 C,N conditional pause alternative: flattened gate pauses/resumes/writes once

No private pydantic-ai imports: unavailable public guard signals are a documented
limit, not permission to import internals. Re-run on every pydantic-ai bump.
"""

import hashlib
import json
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from pydantic import BaseModel
from pydantic_ai import (
    Agent, ApprovalRequired, DeferredToolRequests, DeferredToolResults, NativeOutput,
    RunContext, Tool, ToolApproved,
)
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.conversation import ConversationTypeAdapter
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from galaxie import GalaxieError
from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool

_owner: ContextVar[str | None] = ContextVar('delegation_probe_owner', default=None)


class OwnerCapability(AbstractCapability):
    async def before_run(self, ctx: RunContext) -> None:
        _owner.set(ctx.run_id)


class GuardedModel(GalaxieModel):
    """Probe-local guard using only public hooks and public message identity."""

    def check(self, messages, run_context=None) -> None:
        current = run_context.run_id if run_context is not None else messages[-1].run_id
        if not current or current != _owner.get():
            raise GalaxieError('unsupported')

    async def request(self, messages, model_settings, model_request_parameters):
        self.check(messages)
        return await super().request(messages, model_settings, model_request_parameters)

    @asynccontextmanager
    async def request_stream(self, messages, model_settings, model_request_parameters, run_context=None):
        self.check(messages, run_context)
        async with super().request_stream(messages, model_settings, model_request_parameters, run_context) as result:
            yield result


PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}},
              'required': ['value'], 'additionalProperties': False}


class Answer(BaseModel):
    value: int


def display(requests: DeferredToolRequests) -> dict[str, Any]:
    return {'surfaceId': 'main', 'viewRevision': 'delegation-1',
            'component': 'tests.Approval/v1', 'props': {
                'calls': [{'id': call.tool_call_id, 'name': call.tool_name}
                          for call in requests.approvals],
            }}


def forwarding(ctx: RunContext, variant: str) -> dict[str, Any]:
    options: dict[str, Any] = {'deps': ctx.deps, 'infer_name': False}
    if variant != 'plain':
        options.update(usage=ctx.usage, usage_limits=ctx.usage_limits)
    if variant == 'conv':
        options['conversation_id'] = ctx.conversation_id
    elif variant == 'helper':
        options['conversation_id'] = hashlib.sha256(
            json.dumps([ctx.conversation_id, ctx.tool_call_id]).encode()).hexdigest()
    return options


def preserve_metadata(requests: DeferredToolRequests, action: str, payload: Any) -> DeferredToolResults:
    identifiers = [call.tool_call_id for call in requests.approvals]
    if (action not in ('approve', 'deny') or type(payload) is not dict
            or set(payload) != {'toolCallIds'} or payload['toolCallIds'] != identifiers):
        raise GalaxieError('invalid')
    return DeferredToolResults(approvals={identifier: action == 'approve' for identifier in identifiers},
                               metadata=requests.metadata)


def override_arguments(requests: DeferredToolRequests, action: str, payload: Any) -> DeferredToolResults:
    results = preserve_metadata(requests, action, payload)
    results.metadata = {}
    results.approvals = {
        identifier: ToolApproved(override_args={'child_state': requests.metadata[identifier]['child']})
        if action == 'approve' else False for identifier in results.approvals
    }
    return results


def factory(name: str = 'smoke', variant: str = 'usage') -> Executor:
    """Create unchanged executors; helper/hoist are probe-local author patterns only."""
    guarded = variant == 'guarded' or name in ('guard', 'guard-stream', 'guard-resume')
    require_delegate_approval = name == 'guard-resume'
    model_class = GuardedModel if guarded else GalaxieModel
    owner = [OwnerCapability()] if guarded else []
    if name in ('guard', 'guard-resume'):
        name = 'labels'
    elif name == 'guard-stream':
        name = 'stream'
    if name == 'smoke':
        return Executor(Agent(model_class('answer'), capabilities=owner))
    if name == 'top-retry':
        return Executor(Agent(model_class('answer'), output_type=NativeOutput(Answer), capabilities=owner))
    def make_tool(tool_name: str):
        tool = capability_tool(tool_name, 'math.double@1', PARAMETERS)
        if not guarded:
            return tool

        async def invoke(ctx: RunContext, **arguments):
            if ctx.run_id != _owner.get():
                raise GalaxieError('unsupported')
            return await tool.function(ctx, **arguments)

        return Tool.from_schema(invoke, name=tool_name, description=tool.description,
                                json_schema=PARAMETERS, takes_ctx=True)

    if name == 'top-parallel':
        return Executor(Agent(model_class('answer'), tools=[
            make_tool('double'),
        ], capabilities=owner))
    parent_tools = []
    if name in ('delegation', 'scopes'):
        parent_tools.append(make_tool('double'))
    if name == 'flatten':
        flat_gate = make_tool('gate')
        flat_gate.requires_approval = True
        return Executor(Agent(model_class('answer'), output_type=[str, DeferredToolRequests],
                              tools=[flat_gate], capabilities=owner), interaction=display)
    parent = Agent(model_class('answer'), output_type=[str, DeferredToolRequests], tools=parent_tools, capabilities=owner)
    if name == 'recovery':
        @parent.tool_plain(requires_approval=True)
        async def gate() -> str:
            return 'checkpoint-approved'

    @parent.tool(requires_approval=require_delegate_approval)
    async def delegate(ctx: RunContext, child_state: str | None = None) -> Any:
        tools = []
        if name in ('delegation', 'scopes', 'labels', 'recovery', 'hoist'):
            tools.append(make_tool('double'))
        if name in ('excluded-pause', 'returned-pause', 'hoist', 'parallel-pause'):
            child_gate = make_tool('gate')
            child_gate.requires_approval = True
            tools.append(child_gate)
        if name == 'external':
            async def external(messages, info):
                return ModelResponse(parts=[TextPart('outside-bridge')])
            model = FunctionModel(external)
        else:
            model = model_class('child')
        output_type = NativeOutput(Answer) if name == 'native' else (
            str if name == 'excluded-pause' else [str, DeferredToolRequests])
        child = Agent(model, output_type=output_type, tools=tools)
        if name == 'steps':
            @child.tool_plain
            async def again() -> str:
                return 'again'
        options = forwarding(ctx, variant)
        prompt = 'child-2' if name == 'native' and ctx.tool_call_id == 'delegate-2' else 'child'
        if name == 'stream':
            async with child.run_stream(prompt, **options) as streamed:
                return await streamed.get_output()
        if name in ('hoist', 'parallel-pause') and ctx.tool_call_approved:
            # The parent's synchronous resume callback must explicitly preserve this
            # metadata; the shipped default callback forwards approvals only.
            saved = ConversationTypeAdapter.validate_json(child_state or ctx.tool_call_metadata['child'])
            options['conversation_id'] = saved.conversation_id
            options['message_history'] = saved.messages
            assert saved.deferred_tool_requests is not None
            options['deferred_tool_results'] = DeferredToolResults(
                approvals={call.tool_call_id: True for call in saved.deferred_tool_requests.approvals})
            result = await child.run(None, **options)
        else:
            result = await child.run(prompt, **options)
        if name in ('hoist', 'parallel-pause') and isinstance(result.output, DeferredToolRequests):
            raise ApprovalRequired(metadata={'child': ConversationTypeAdapter.dump_json(result.conversation).decode()})
        return result.output

    return Executor(parent, interaction=display,
                    resume=(override_arguments if variant == 'override' else preserve_metadata)
                    if name in ('hoist', 'parallel-pause') and variant != 'lost-metadata' else None)
