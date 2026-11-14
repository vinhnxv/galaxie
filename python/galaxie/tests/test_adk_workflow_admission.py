# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import pytest
from google.adk.agents import LlmAgent
from google.adk.workflow import JoinNode

from galaxie import GalaxieError, _bridge
from galaxie import adk


def test_registered_chain_and_fanout_prepare_without_dispatch():
    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')
    _bridge.install_transport(forbidden)
    for fanout in (False, True):
        def leaf(name):
            return LlmAgent(name=name, model=adk.llm(name))
        edges = [('START', leaf('a'), (leaf('b'), leaf('c')), JoinNode(name='join'))] if fanout else [
            ('START', leaf('a'), leaf('b'))]
        root = adk.workflow(name='wf', edges=edges)
        assert adk.prepare_executor(root).agent is root


@pytest.mark.parametrize('kind', [
    'author-function', 'retry', 'timeout', 'nested', 'tool-node', 'cycle', 'rerun',
    'parallel-worker', 'confirmation', 'long-running', 'model', 'repeated-name',
])
def test_registered_helper_still_refuses_excluded_constructs(kind):
    from test_adk_workflow_refusals import excluded

    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')
    _bridge.install_transport(forbidden)
    raw = excluded(kind)
    with pytest.raises(GalaxieError) as error:
        root = adk.workflow(name='wf', edges=raw.edges)
        adk.prepare_executor(root)
    assert error.value.code == 'unsupported'
