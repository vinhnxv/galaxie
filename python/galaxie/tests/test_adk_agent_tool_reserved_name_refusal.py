# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import pytest
from google.adk.agents import LlmAgent
from google.adk.tools import AgentTool

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, llm


def outer(wrapper):
    inner = LlmAgent(name='transfer_to_agent', model=llm('inner'))
    child = LlmAgent(name='child', model=llm('child'))
    return LlmAgent(name='outer', model=llm('outer'), tools=[wrapper(inner)], sub_agents=[child])


def test_raw_reserved_name_wrapper_is_refused_at_prepare_without_dispatch():
    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')
    _bridge.install_transport(forbidden)
    with pytest.raises(GalaxieError) as error:
        Executor(outer(AgentTool))
    assert error.value.code == 'unsupported'
