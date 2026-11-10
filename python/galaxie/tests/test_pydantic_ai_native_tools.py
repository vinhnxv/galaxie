# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
"""Pinned native-tool probes, with the outcome rule fixed before measurement.

Each cell is one native-tool kind in gap 1, or all of dynamic tools (gap 2)
or response parts (gap 3). Results are satisfied, not satisfied, or unmeasured.
Supported requires all four: a repository provider executes the kind; the
bridge accepts its declaration and result; a router feature names the kind;
and a probe proves broker grants, labels, budgets and confirmation apply.
Alternative requires failed support, a retrieval kind (web_search, web_fetch,
x_search, file_search, mcp_server), and satisfied N4. Otherwise refused requires
N2 or the gap's equivalent: fixed unsupported and zero model, capability and
interaction requests. A P0 bypass is unsafe as shipped; an unmeasured P0 makes
its cell undetermined. Informational observations never establish support.

Probe | Satisfied when (C = CPython, N = Node Pyodide, B = bridge)
N1 C,N | Static native kinds refuse at both prepare entries, zero requests.
N2 C,N | Requests refuse unsupported before any bridge request.
N3 C   | Default-native adaptive capabilities satisfy N1.
N4 C,N | Ordinary and explicit local search have equal transcripts, exactly
         one model request with one function declaration and no extra option,
         one capability call and pydantic-ai/<conversation>/<n>/<n> scope.
N5 C   | Informational: local fallback with native default is refused.
N6 C,N | Baseline, ordinary and capability tools prepare and run.
N7 C   | Informational: deferred loading refuses at request, zero requests.
D1 C,N | Native factories refuse at prepare or request, zero requests.
D2 C   | Override refuses unsupported, zero requests.
D3 C   | Direct request/stream, including optional tools, refuse, zero requests.
D4 C   | Informational: fixed first/resumed agent.run keyword names.
RP1 C  | Four native history parts refuse unsupported, zero requests.
RP2 C  | Extra reply key, non-function call, undeclared name refuse invalid.
B1 B   | Native/builtin options and non-function declarations refuse invalid.
B2 B   | Extra response part key refuses invalid.
RP3 N  | Array provider content refuses unsupported before Python reply;
         exactly one model call and zero capability calls.
RP4 N  | Informational, reasoned only: internal provider tools returning text
         cannot be observed by the adapter.

The exact one-model-request criterion in N4 remains fixed even if an ordinary
function-tool round trip needs more requests. Pin observations, then apply the
rule literally; do not change criteria to fit measurements.
"""

import asyncio
import json
import re
from collections import Counter
from typing import Any
from unittest.mock import patch

import pytest
from pydantic_ai import Agent, DeferredToolRequests, RunContext, Tool
from pydantic_ai.capabilities import MCP, ImageGeneration, NativeTool, WebFetch, WebSearch, XSearch
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    ModelResponse, NativeToolCallPart, NativeToolReturnPart,
    NativeToolSearchCallPart, NativeToolSearchReturnPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.native_tools import NATIVE_TOOL_TYPES, AbstractNativeTool, WebSearchTool

from galaxie import _bridge
from galaxie._bridge import GalaxieError
from galaxie.pydantic_ai import Executor, GalaxieModel, _messages, _reply, capability_tool, prepare_executor


KINDS = sorted(NATIVE_TOOL_TYPES)
EXPECTED_KINDS = [
    'advisor', 'code_execution', 'file_search', 'image_generation', 'mcp_server',
    'memory', 'tool_search', 'web_fetch', 'web_search', 'x_search',
]
SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}


def native_tool(kind: str) -> AbstractNativeTool:
    arguments: dict[str, dict[str, Any]] = {
        'advisor': {'model': 'offline-advisor'},
        'file_search': {'file_store_ids': ['offline-store']},
        'mcp_server': {'id': 'offline-server', 'url': 'https://example.invalid/mcp'},
    }
    return NATIVE_TOOL_TYPES[kind](**arguments.get(kind, {}))


def transport_for(replies: list[Any], seen: list[dict[str, Any]]) -> None:
    replies_iter = iter(replies)

    async def transport(raw: str) -> str:
        message = json.loads(raw)
        seen.append(message)
        reply = next(replies_iter)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)


def assert_error(error: pytest.ExceptionInfo[GalaxieError], code: str = 'unsupported') -> None:
    assert error.value.code == code
    assert str(error.value) == ('This operation is unsupported.' if code == 'unsupported' else 'The request is invalid.')


def assert_counts(seen: list[dict[str, Any]], *, model: int = 0, capability: int = 0) -> None:
    assert Counter(message['op'] for message in seen) == Counter({'model': model, 'capability': capability})


def call(name: str = 'search', arguments: str = '{"query":"question"}') -> dict[str, Any]:
    return {'id': 'call_1', 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def test_n1_registry_has_no_unmeasured_kind() -> None:
    # Every registered kind must be constructed, so a version bump reopens the evidence.
    assert KINDS == EXPECTED_KINDS
    assert [native_tool(kind).kind for kind in KINDS] == KINDS


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('prepare', [Executor, prepare_executor])
def test_n1_static_native_tools_are_accepted_at_prepare(kind: str, prepare: Any) -> None:
    # Prepare refusal is not satisfied: these agents currently pass construction.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    if kind == 'tool_search':
        # Upstream rejects the conflicting required/auto-optional definitions first.
        with pytest.raises(UserError) as error:
            Agent(GalaxieModel('answer'), capabilities=[NativeTool(native_tool(kind))])
        assert str(error.value) == (
            "Native tool id 'tool_search' maps to conflicting definitions in agent capabilities. "
            'Native tool ids must be unique within a capability layer.'
        )
    else:
        executor = prepare(Agent(GalaxieModel('answer'), capabilities=[NativeTool(native_tool(kind))]))
        assert isinstance(executor, Executor)
    assert_counts(seen)


@pytest.mark.parametrize('kind', KINDS)
def test_n2_static_native_tools_refuse_at_first_request(kind: str) -> None:
    # Refusal requires fixed unsupported and no model/capability/interaction traffic.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        if kind == 'tool_search':
            # Agent construction conflicts with its auto tool; pin the direct backstop.
            asyncio.run(GalaxieModel('answer').request([], None, ModelRequestParameters(native_tools=[native_tool(kind)])))
        else:
            executor = Executor(Agent(GalaxieModel('answer'), capabilities=[NativeTool(native_tool(kind))]))
            asyncio.run(executor.run({'prompt': 'question'}, 'native-static', 5))
    assert_error(error)
    assert_counts(seen)


@pytest.mark.parametrize('capability', [
    WebSearch(), WebFetch(), ImageGeneration(), XSearch(),
    MCP(native=True, local=False, url='https://example.invalid/mcp', id='offline-server'),
], ids=['web-search', 'web-fetch', 'image-generation', 'x-search', 'mcp-native-only'])
@pytest.mark.parametrize('prepare', [Executor, prepare_executor])
def test_n3_adaptive_native_tools_accept_prepare_and_refuse_run(capability: Any, prepare: Any) -> None:
    # Prepare refusal is not satisfied; native-only MCP needs no optional MCP package.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    executor = prepare(Agent(GalaxieModel('answer'), capabilities=[capability]))
    assert_counts(seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'question'}, 'native-adaptive', 5))
    assert_error(error)
    assert_counts(seen)


def test_n4_explicit_local_search_equals_an_ordinary_capability_tool_but_uses_two_requests() -> None:
    # The fixed one-model-request condition is not satisfied, despite equivalence.
    transcripts = []
    for local_search in [False, True]:
        seen: list[dict[str, Any]] = []
        transport_for([
            {'content': '', 'toolCalls': [call()]},
            {'documents': ['passage']},
            {'content': 'answer'},
        ], seen)
        tool = capability_tool('search', 'docs.search@1', SCHEMA)
        agent = Agent(GalaxieModel('answer'), capabilities=[WebSearch(native=False, local=tool)]) if local_search else Agent(GalaxieModel('answer'), tools=[tool])
        assert asyncio.run(Executor(agent).run({'prompt': 'question'}, 'retrieval', 5)) == 'answer'
        assert_counts(seen, model=2, capability=1)
        requests = [message['payload'] for message in seen if message['op'] == 'model']
        for request in requests:
            assert set(request['options']) == {'tools', 'toolChoice'}
            assert request['options']['toolChoice'] == 'auto'
            assert len(request['options']['tools']) == 1
            assert request['options']['tools'][0]['type'] == 'function'
        capability = next(message['payload'] for message in seen if message['op'] == 'capability')
        assert capability == {
            'name': 'docs.search@1', 'input': {'query': 'question'},
            'effectScope': 'pydantic-ai/retrieval/1/0', 'tool': True,
        }
        assert re.fullmatch(r'pydantic-ai/retrieval/\d+/\d+', capability['effectScope'])
        transcripts.append(requests)
    # The plain form also covers file retrieval without a provider-side file tool.
    assert transcripts[0] == transcripts[1]


def test_n5_local_search_with_native_default_is_refused_at_request() -> None:
    # Informational: authors must explicitly choose native=False for the local path.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    tool = capability_tool('search', 'docs.search@1', SCHEMA)
    executor = Executor(Agent(GalaxieModel('answer'), capabilities=[WebSearch(local=tool)]))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'question'}, 'native-default', 5))
    assert_error(error)
    assert_counts(seen)


@pytest.mark.parametrize('shape', ['baseline', 'function', 'capability'])
def test_n6_ordinary_agents_prepare_and_run(shape: str) -> None:
    # The auto-injected optional tool_search must not newly reject ordinary agents.
    seen: list[dict[str, Any]] = []
    tools: list[Any] = []
    replies: list[Any] = [{'content': 'answer'}]
    if shape == 'capability':
        tools = [capability_tool('search', 'docs.search@1', SCHEMA)]
        replies = [{'content': '', 'toolCalls': [call()]}, {'documents': ['passage']}, {'content': 'answer'}]
    elif shape == 'function':
        def search(query: str) -> str:
            return query
        tools = [Tool(search)]
        replies = [{'content': '', 'toolCalls': [call()]}, {'content': 'answer'}]
    transport_for(replies, seen)
    agent = Agent(GalaxieModel('answer'), tools=tools)
    assert [(tool.kind, tool.optional) for tool in agent.root_capability.get_native_tools() if isinstance(tool, AbstractNativeTool)] == [('tool_search', True)]
    executor = Executor(agent)
    assert prepare_executor(executor) is executor
    assert asyncio.run(executor.run({'prompt': 'question'}, 'ordinary', 5)) == 'answer'
    assert_counts(seen, model=1 if shape == 'baseline' else 2, capability=int(shape == 'capability'))


def test_n7_deferred_loading_refuses_at_request() -> None:
    # Informational: the optional native search is activated by deferred tools.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)

    def lookup() -> str:
        return 'unused'

    executor = Executor(Agent(GalaxieModel('answer'), tools=[Tool(lookup, defer_loading=True)]))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'question'}, 'deferred-loading', 5))
    assert_error(error)
    assert_counts(seen)


@pytest.mark.parametrize('returns_tool', [True, False])
def test_d1_native_factories_accept_prepare(returns_tool: bool) -> None:
    # A factory returning None currently runs: request refusal is not satisfied.
    seen: list[dict[str, Any]] = []
    transport_for([{'content': 'answer'}] if not returns_tool else [], seen)

    def factory(ctx: RunContext[Any]) -> AbstractNativeTool | None:
        return WebSearchTool() if returns_tool else None

    agent = Agent(GalaxieModel('answer'), capabilities=[NativeTool(factory)])
    executor = Executor(agent)
    assert prepare_executor(agent).agent is agent
    if returns_tool:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(executor.run({'prompt': 'question'}, 'native-factory', 5))
        assert_error(error)
        assert_counts(seen)
    else:
        assert asyncio.run(executor.run({'prompt': 'question'}, 'native-factory', 5)) == 'answer'
        assert_counts(seen, model=1)


def test_d2_native_override_refuses_before_transport() -> None:
    # The request-time backstop must cover tools not present at prepare.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    agent = Agent(GalaxieModel('answer'))
    executor = Executor(agent)
    with agent.override(native_tools=[WebSearchTool()]):
        with pytest.raises(GalaxieError) as error:
            asyncio.run(executor.run({'prompt': 'question'}, 'native-override', 5))
    assert_error(error)
    assert_counts(seen)


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('optional', [False, True])
def test_d3_direct_native_request_refuses_even_optional_tools(stream: bool, optional: bool) -> None:
    # Native parameters must be refused before support filtering can drop them.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    parameters = ModelRequestParameters(native_tools=[WebSearchTool(optional=optional)])

    async def run() -> None:
        model = GalaxieModel('answer')
        if stream:
            async with model.request_stream([], None, parameters):
                pytest.fail('A native request must refuse before yielding a stream.')
        else:
            await model.request([], None, parameters)

    with pytest.raises(GalaxieError) as error:
        asyncio.run(run())
    assert_error(error)
    assert_counts(seen)


def test_d4_first_and_resumed_run_keyword_names_are_fixed() -> None:
    # Informational: the executor exposes no per-run capabilities option.
    seen: list[dict[str, Any]] = []
    transport_for([{'content': '', 'toolCalls': [call('save', '{"value":7}')]}, {'content': 'answer'}], seen)
    agent = Agent(GalaxieModel('answer'), output_type=[str, DeferredToolRequests])
    executed = []

    @agent.tool_plain(requires_approval=True)
    def save(value: int) -> str:
        executed.append(value)
        return 'saved'

    executor = Executor(agent, interaction=lambda requests: {
        'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1', 'props': {},
    })

    async def run() -> None:
        with patch.object(agent, 'run', wraps=agent.run) as wrapped:
            assert await executor.run({'prompt': 'save'}, 'run-keywords', 5) is None
            pending = executor.pending('run-keywords')
            assert pending is not None
            assert await executor.run(None, 'run-keywords', 5, resume={
                'interactionId': pending['id'], 'action': 'approve', 'payload': {'toolCallIds': ['call_1']},
            }) == 'answer'
        assert [set(item.kwargs) for item in wrapped.call_args_list] == [
            {'conversation_id', 'usage_limits', 'infer_name'},
            {'conversation_id', 'usage_limits', 'infer_name', 'deferred_tool_results', 'message_history', 'usage'},
        ]

    asyncio.run(run())
    assert executed == [7]
    assert_counts(seen, model=2)


@pytest.mark.parametrize('part', [
    NativeToolCallPart('web_search', {}, tool_call_id='native-1'),
    NativeToolReturnPart('web_search', 'result', tool_call_id='native-1'),
    NativeToolSearchCallPart(args={'queries': ['question']}, tool_call_id='native-1'),
    NativeToolSearchReturnPart(content={'discovered_tools': []}, tool_call_id='native-1'),
], ids=['call', 'return', 'search-call', 'search-return'])
def test_rp1_native_history_parts_refuse_before_transport(part: Any) -> None:
    # There is no native result channel in the closed Python history mapper.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        _messages([ModelResponse(parts=[part])], ModelRequestParameters())
    assert_error(error)
    assert_counts(seen)


@pytest.mark.parametrize('reply', [
    {'content': '', 'nativeToolCalls': []},
    {'content': '', 'toolCalls': [{**call(), 'type': 'web_search'}]},
    {'content': '', 'toolCalls': [call('web_search', '{}')]},
], ids=['extra-native-key', 'non-function-call', 'undeclared-native-name'])
def test_rp2_native_reply_shapes_refuse_invalid(reply: Any) -> None:
    # Only declared function calls can enter the framework from bridge replies.
    seen: list[dict[str, Any]] = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        _reply(reply, [], {'search'}, 'answer')
    assert_error(error, 'invalid')
    assert_counts(seen)
