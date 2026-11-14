# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from test_adk_agent_tool_reserved_name_refusal import outer
import pytest
from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, agent_tool


def test_registered_wrapper_refuses_injected_transfer_tool_collision_at_prepare():
    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')
    _bridge.install_transport(forbidden)
    with pytest.raises(GalaxieError) as error:
        Executor(outer(agent_tool))
    assert error.value.code == 'unsupported'
