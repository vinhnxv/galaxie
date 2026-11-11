# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from pydantic_ai import Agent, DeferredToolRequests, RunContext, Tool

from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool, hoisted_child_requests, run_child

CASES = ('child-approval-approve', 'child-approval-reject', 'child-approval-restore')
PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}},
              'required': ['value'], 'additionalProperties': False}
EMPTY = {'type': 'object', 'properties': {}, 'additionalProperties': False}


def factory(name, parent_model=None, child_model=None, delegate=run_child, reader=hoisted_child_requests):
    if name not in CASES:
        raise ValueError('The child approval conformance case is unknown.')
    save = capability_tool('save', 'math.double@1', PARAMETERS, 'Save a doubled integer.')
    save.requires_approval = True
    child = Agent(child_model or GalaxieModel('child'), tools=[save], output_type=[str, DeferredToolRequests])

    async def invoke(ctx: RunContext) -> str:
        result = await delegate(ctx, child, 'child', hoist_approvals=True)
        assert not isinstance(result.output, DeferredToolRequests)
        return result.output

    tool = Tool.from_schema(invoke, name='delegate', description='Delegate to the child.',
                            json_schema=EMPTY, takes_ctx=True)
    parent = Agent(parent_model or GalaxieModel('parent'), tools=[tool],
                   output_type=[str, DeferredToolRequests], name='child-approval-conformance')

    def interaction(requests):
        children = reader(requests)
        return {'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1', 'props': {
            'calls': [{
                'id': call.tool_call_id, 'name': call.tool_name, 'arguments': call.args_as_json_str(),
                'child': [{'id': pending.tool_call_id, 'name': pending.tool_name,
                           'arguments': pending.args_as_json_str()}
                          for pending in children[call.tool_call_id].approvals],
            } for call in requests.approvals],
        }}

    return Executor(parent, interaction=interaction)
