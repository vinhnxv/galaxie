# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from pydantic_ai import Agent, DeferredToolRequests, RunContext, Tool

from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool, run_child

CASES = ('delegation-reload-write', 'delegation-shared-budgets', 'delegation-nested-plain-refused')
PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}},
              'required': ['value'], 'additionalProperties': False}
EMPTY = {'type': 'object', 'properties': {}, 'additionalProperties': False}


def factory(name, parent_model=None, child_model=None, delegate=run_child):
    if name not in CASES:
        raise ValueError('The delegation conformance case is unknown.')
    child = Agent(child_model or GalaxieModel('child'))
    if name == 'delegation-reload-write':
        child = Agent(child_model or GalaxieModel('child'), tools=[
            capability_tool('save', 'math.double@1', PARAMETERS, 'Save a doubled integer.'),
        ])
    elif name == 'delegation-shared-budgets':
        @child.tool_plain
        async def again() -> str:
            return 'again'

    async def invoke(ctx: RunContext):
        if name == 'delegation-nested-plain-refused':
            return (await child.run('child', infer_name=False)).output
        return (await delegate(ctx, child, 'child')).output

    tools = [Tool.from_schema(invoke, name='delegate', description='Delegate to the child.',
                              json_schema=EMPTY, takes_ctx=True)]
    if name == 'delegation-reload-write':
        async def gate():
            return 'approved'
        tool = Tool.from_schema(gate, name='gate', description='Approve delegation.', json_schema=EMPTY)
        tool.requires_approval = True
        tools.append(tool)
    parent = Agent(parent_model or GalaxieModel('parent'), tools=tools,
                   output_type=[str, DeferredToolRequests], name='delegation-conformance')

    def interaction(requests):
        return {'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1', 'props': {
            'calls': [{'id': call.tool_call_id, 'name': call.tool_name, 'arguments': call.args_as_json_str()}
                      for call in requests.approvals],
        }}

    return Executor(parent, interaction=interaction)
