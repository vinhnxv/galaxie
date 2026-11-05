# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from pydantic_ai import Agent, DeferredToolRequests

from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool


def factory(mode):
    tool = capability_tool('double', 'math.double@1', {
        'type': 'object', 'properties': {'value': {'type': 'integer'}},
        'required': ['value'], 'additionalProperties': False,
    }, 'Double an integer.')
    tool.requires_approval = mode == 'approved-write'
    agent = Agent(GalaxieModel('answer'), output_type=[str, DeferredToolRequests], tools=[tool])
    if mode != 'approved-write':
        @agent.tool_plain(requires_approval=True)
        async def confirm() -> str:
            return 'confirmed'

    return Executor(agent, interaction=lambda requests: {
        'surfaceId': 'main', 'viewRevision': '1', 'component': 'tests.Approval/v1',
        'props': {'calls': [{'id': call.tool_call_id} for call in requests.approvals]},
    })
