# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Test-local extension of the earlier tool-call candidate."""

from langchain_core.runnables import RunnableConfig

from galaxie import GalaxieError
from tool_candidate import CapabilityTool, ToolCandidate, capability_tool
from tool_scope import check


class ScopedCapabilityTool(CapabilityTool):
    """A capability tool whose coroutine participates in execution containment."""


def scoped_capability_tool(name, capability, parameters, description):
    original = capability_tool(name, capability, parameters, description)
    coroutine = original.coroutine
    assert coroutine is not None

    async def invoke(config: RunnableConfig, **arguments):
        scope = check()
        try:
            return await coroutine(config=config, **arguments)
        except GalaxieError as error:
            if error.code != 'denied':
                scope.latch(error.code)
            raise

    return ScopedCapabilityTool(name=original.name, description=original.description,
                                args_schema=original.args_schema, coroutine=invoke)


class ScopedToolCandidate(ToolCandidate):
    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        if not isinstance(tools, (list, tuple)) or any(not isinstance(tool, ScopedCapabilityTool) for tool in tools):
            raise GalaxieError('unsupported')
        return super().bind_tools(tools, tool_choice=tool_choice, **kwargs)

    def _payload(self, messages, stop):
        scope = check()
        try:
            return super()._payload(messages, stop)
        except GalaxieError as error:
            scope.latch(error.code)
            raise

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        scope = check()
        try:
            return await super()._agenerate(messages, stop, run_manager, **kwargs)
        except GalaxieError as error:
            scope.latch(error.code)
            raise

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        check().latch('unsupported')
        raise GalaxieError('unsupported')
        yield
