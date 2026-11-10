# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import ast
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, DeferredToolRequests, NativeOutput, RunContext
from pydantic_ai.capabilities import NativeTool, ProcessHistory, WebSearch
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.output import OutputObjectDefinition
from pydantic_ai.usage import RunUsage, UsageLimits

from galaxie import GalaxieError, _bridge
from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool, run_child


def call(name, identifier='call-1', arguments='{}'):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def install_replies(replies, seen):
    replies = iter(replies)

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': next(replies)})

    _bridge.install_transport(transport)


def tool_context(identifier='delegate-1', **options):
    model = GalaxieModel('parent')
    return RunContext(
        deps={'parent': 'dependency'}, model=model, usage=RunUsage(),
        usage_limits=UsageLimits(request_limit=5), conversation_id='fixed',
        messages=[ModelRequest(parts=[UserPromptPart('parent')]), ModelResponse(parts=[
            ToolCallPart('delegate', '{}', tool_call_id=identifier),
        ])], tool_call_id=identifier, tool_name='delegate', **options,
    )


def test_plain_nested_run_is_refused_before_child_bridge_traffic():
    seen = []

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['payload']['role'])
        reply = {'content': 'done'} if len(seen) > 1 else {
            'content': '', 'toolCalls': [{
                'id': 'delegate-1', 'type': 'function',
                'function': {'name': 'delegate', 'arguments': '{}'},
            }],
        }
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    parent = Agent(GalaxieModel('parent'))
    child = Agent(GalaxieModel('child'))

    @parent.tool_plain
    async def delegate() -> str:
        return (await child.run('child')).output

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 5))
    assert error.value.code == 'unsupported'
    assert seen == ['parent']


@pytest.mark.parametrize('shape', ['replay', 'turns', 'parallel', 'keys'])
def test_child_identity_follows_position_and_key_instead_of_provider_call_id(shape):
    seen = []
    identities = []
    delegate_id = ['delegate-original']

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        payload = message['payload']
        if message['op'] == 'capability':
            reply = 'written'
        elif payload['messages'][-1]['role'] == 'tool':
            reply = {'content': 'done'}
        elif payload['role'] == 'child':
            reply = {'content': '', 'toolCalls': [call('write')]}
        else:
            calls = [call('delegate', delegate_id[0])]
            if shape == 'parallel':
                calls.append(call('delegate', 'delegate-sibling'))
            reply = {'content': '', 'toolCalls': calls}
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    child = Agent(GalaxieModel('child'), tools=[capability_tool('write', 'records.save@1', {'type': 'object'})])
    parent = Agent(GalaxieModel('parent'))

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        for key in ('first', 'second') if shape == 'keys' else ('',):
            result = await run_child(ctx, child, 'child', key=key)
            identities.append(result.conversation.conversation_id)
        return 'delegated'

    async def run():
        executor = Executor(parent)
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) == 'done'
        if shape in ('replay', 'turns'):
            delegate_id[0] = 'delegate-regenerated'
            if shape == 'replay':
                executor = Executor(parent)
            assert await executor.run({'prompt': 'parent'}, 'fixed', 8) == 'done'

    asyncio.run(run())
    scopes = [message['payload']['effectScope'] for message in seen if message['op'] == 'capability']
    assert len(identities) == len(scopes) == 2
    assert all(identifier != 'fixed' for identifier in identities)
    assert [scope.split('/')[1] for scope in scopes] == identities
    assert [scope.split('/')[2:] for scope in scopes] == [['1', '0'], ['5' if shape == 'turns' else '1', '0']]
    assert (identities[0] == identities[1]) == (shape == 'replay')
    assert (scopes[0] == scopes[1]) == (shape == 'replay')


@pytest.mark.parametrize('option', ['usage', 'usage_limits', 'conversation_id', 'run_id', 'infer_name', 'metadata'])
def test_reserved_child_options_fail_before_transport(option):
    seen = []
    install_replies([], seen)
    options: dict[str, Any] = {option: None}
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run_child(tool_context(), Agent(GalaxieModel('child')), 'child', **options))
    assert error.value.code == 'invalid'
    assert seen == []


@pytest.mark.parametrize('override', [False, True])
def test_non_galaxie_child_models_and_model_overrides_are_refused(override):
    seen = []
    install_replies([], seen)
    external = FunctionModel(lambda messages, info: ModelResponse(parts=[TextPart('external')]))
    child = Agent(GalaxieModel('child') if override else external)
    options: dict[str, Any] = {'model': external} if override else {}
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run_child(tool_context(), child, 'child', **options))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('shape', ['native-tool', 'native-factory', 'native-output-with-tool', 'instrumentation', 'settings'])
def test_child_validation_keeps_existing_prepare_refusals(shape):
    seen = []
    install_replies([], seen)
    if shape == 'native-tool':
        child = Agent(GalaxieModel('child'), capabilities=[WebSearch()])
    elif shape == 'native-factory':
        def factory(ctx):
            pytest.fail('Native-tool factories must not be executed during validation')
        child = Agent(GalaxieModel('child'), capabilities=[NativeTool(factory)])
    elif shape == 'native-output-with-tool':
        child = Agent(GalaxieModel('child'), output_type=NativeOutput(Answer), tools=[
            capability_tool('write', 'records.save@1', {'type': 'object'}),
        ])
    elif shape == 'instrumentation':
        child = Agent(GalaxieModel('child'))
        child.instrument = True
    else:
        child = Agent(GalaxieModel('child'), model_settings={'temperature': 0})
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run_child(tool_context(), child, 'child'))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_duplicate_child_identity_is_refused_only_in_the_current_run():
    seen = []
    identities = []
    replies = [
        {'content': '', 'toolCalls': [call('delegate')]}, {'content': 'child'}, {'content': 'parent'},
    ]
    install_replies(replies * 2, seen)
    child = Agent(GalaxieModel('child'))
    parent = Agent(GalaxieModel('parent'))

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        result = await run_child(ctx, child, 'child')
        identities.append(result.conversation.conversation_id)
        with pytest.raises(GalaxieError) as error:
            await run_child(ctx, child, 'child')
        assert error.value.code == 'invalid'
        return 'delegated'

    async def run():
        for _ in range(2):
            assert await Executor(parent).run({'prompt': 'parent'}, 'fixed', 5) == 'parent'

    asyncio.run(run())
    assert identities[0] == identities[1]
    assert [message['payload']['role'] for message in seen] == ['parent', 'child', 'parent'] * 2


def test_child_usage_and_limits_are_shared_and_dependencies_can_be_overridden():
    seen = []
    contexts = []
    install_replies([
        {'content': '', 'toolCalls': [call('delegate')]}, {'content': 'first'}, {'content': 'second'}, {'content': 'parent'},
    ], seen)
    child = Agent(GalaxieModel('child'))
    parent = Agent(GalaxieModel('parent'))

    @child.output_validator
    def remember(ctx: RunContext, output: str) -> str:
        contexts.append(ctx)
        return output

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        await run_child(ctx, child, 'first')
        assert ctx.usage.requests == 2
        await run_child(ctx, child, 'second', key='second', deps='overridden')
        assert ctx.usage.requests == 3
        assert contexts[0].usage is contexts[1].usage is ctx.usage
        assert contexts[0].usage_limits is contexts[1].usage_limits is ctx.usage_limits
        assert contexts[0].deps is ctx.deps
        assert contexts[1].deps == 'overridden'
        assert contexts[0].run_id != contexts[1].run_id != ctx.run_id
        return 'delegated'

    assert asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 5)) == 'parent'
    assert len(seen) == 4


def test_child_requests_consume_the_parent_step_budget():
    seen = []
    install_replies([
        {'content': '', 'toolCalls': [call('delegate')]}, {'content': 'child'},
    ], seen)
    parent = Agent(GalaxieModel('parent'))
    child = Agent(GalaxieModel('child'))

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        return (await run_child(ctx, child, 'child')).output

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 2))
    assert error.value.code == 'budget_exceeded'
    assert [message['payload']['role'] for message in seen] == ['parent', 'child']


class Answer(BaseModel):
    value: int


def test_native_children_have_independent_repairs_and_restore_the_parent_counter():
    seen = []
    install_replies([
        {'content': '', 'toolCalls': [call('delegate')]}, {'content': '{"value":1}'},
        {'content': '{"value":"invalid"}'}, {'content': '{"value":2}'},
        {'content': '{"value":3}'}, {'content': '{"value":4}'}, {'content': 'parent'},
    ], seen)
    child = Agent(GalaxieModel('child'), output_type=NativeOutput(Answer), retries=1)
    parent = Agent(GalaxieModel('parent'))

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        parameters = ModelRequestParameters(
            output_mode='native', output_object=OutputObjectDefinition(json_schema=Answer.model_json_schema(), name='Answer'),
        )
        await GalaxieModel('parent-native').request(
            [ModelRequest(parts=[UserPromptPart('before')], run_id=ctx.run_id)], None, parameters,
        )
        assert (await run_child(ctx, child, 'first')).output == Answer(value=2)
        assert (await run_child(ctx, child, 'second', key='second')).output == Answer(value=3)
        await GalaxieModel('parent-native').request(
            [ModelRequest(parts=[UserPromptPart('after')], run_id=ctx.run_id)], None, parameters,
        )
        return 'delegated'

    assert asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 8)) == 'parent'
    native = [(message['payload']['role'], message['payload']['options'].get('repairAttempt'))
              for message in seen if 'jsonSchema' in message['payload']['options']]
    assert native == [('parent-native', None), ('child', None), ('child', 1), ('child', None), ('parent-native', 1)]


def test_plain_nested_stream_and_nested_executor_are_refused_before_transport():
    async def run(shape):
        seen = []
        install_replies([{'content': '', 'toolCalls': [call('delegate')]}], seen)
        child = Agent(GalaxieModel('child'))
        parent = Agent(GalaxieModel('parent'))

        @parent.tool_plain
        async def delegate() -> str:
            if shape == 'stream':
                async with child.run_stream('child') as result:
                    return await result.get_output()
            return await Executor(child).run({'prompt': 'child'}, 'child-conversation', 5)

        with pytest.raises(GalaxieError) as error:
            await Executor(parent).run({'prompt': 'parent'}, 'fixed', 5)
        assert error.value.code == 'unsupported'
        assert [message['payload']['role'] for message in seen] == ['parent']

    for shape in ('stream', 'executor'):
        asyncio.run(run(shape))


def test_plain_function_model_child_cannot_invoke_a_capability_tool():
    seen = []
    install_replies([{'content': '', 'toolCalls': [call('delegate')]}], seen)
    child = Agent(
        FunctionModel(lambda messages, info: ModelResponse(parts=[ToolCallPart('write', '{}', tool_call_id='write-1')])),
        tools=[capability_tool('write', 'records.save@1', {'type': 'object'})],
    )
    parent = Agent(GalaxieModel('parent'))

    @parent.tool_plain
    async def delegate() -> str:
        return (await child.run('child')).output

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 5))
    assert error.value.code == 'unsupported'
    assert [message['op'] for message in seen] == ['model']


@pytest.mark.parametrize('operation', ['model', 'stream', 'capability'])
@pytest.mark.parametrize('identifier', [None, 'unregistered'])
def test_direct_calls_inside_executor_fail_closed_without_an_allowed_run_id(operation, identifier):
    seen = []
    install_replies([{'content': '', 'toolCalls': [call('delegate')]}], seen)
    parent = Agent(GalaxieModel('parent'))

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart('direct')], run_id=identifier)]
        if operation == 'model':
            await GalaxieModel('child').request(messages, None, ModelRequestParameters())
        elif operation == 'stream':
            async with GalaxieModel('child').request_stream(messages, None, ModelRequestParameters()):
                pass
        else:
            await capability_tool('write', 'records.save@1', {'type': 'object'}).function(replace(ctx, run_id=identifier))
        return 'unreachable'

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(parent).run({'prompt': 'parent'}, 'fixed', 5))
    assert error.value.code == 'unsupported'
    assert [message['payload']['role'] for message in seen] == ['parent']


def test_history_normalization_that_loses_run_identity_is_refused_before_the_retry():
    seen = []
    install_replies([{'content': '{"value":"invalid"}'}], seen)

    def drop_replies(messages: list[ModelMessage]) -> list[ModelMessage]:
        return [message for message in messages if isinstance(message, ModelRequest)]

    agent = Agent(
        GalaxieModel('parent'), output_type=NativeOutput(Answer), retries=1,
        capabilities=[ProcessHistory(drop_replies)],
    )
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(agent).run({'prompt': 'parent'}, 'fixed', 5))
    assert error.value.code == 'unsupported'
    assert len(seen) == 1


def test_resumed_run_can_delegate_and_later_top_level_runs_remain_allowed():
    seen = []
    install_replies([
        {'content': '', 'toolCalls': [call('gate', 'gate-1')]},
        {'content': '', 'toolCalls': [call('delegate', 'delegate-1')]}, {'content': 'child'}, {'content': 'parent'},
        {'content': 'later'},
    ], seen)
    parent = Agent(GalaxieModel('parent'), output_type=[str, DeferredToolRequests])
    child = Agent(GalaxieModel('child'))

    @parent.tool_plain(requires_approval=True)
    async def gate() -> str:
        return 'approved'

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        return (await run_child(ctx, child, 'child')).output

    executor = Executor(parent, interaction=lambda requests: {
        'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1', 'props': {},
    })

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 5) is None
        pending = executor.pending('fixed')
        assert pending is not None
        assert await executor.run(None, 'fixed', 5, resume={
            'interactionId': pending['id'], 'action': 'approve', 'payload': {'toolCallIds': ['gate-1']},
        }) == 'parent'
        assert await executor.run({'prompt': 'later'}, 'fixed', 5) == 'later'

    asyncio.run(run())
    assert [message['payload']['role'] for message in seen] == ['parent', 'parent', 'child', 'parent', 'parent']


def test_direct_model_and_child_calls_outside_executor_remain_available():
    seen = []
    observed = []
    install_replies([{'content': 'direct'}, {'content': 'child'}, {'content': 'child'}], seen)
    child = Agent(GalaxieModel('child'))
    context = tool_context()

    @child.output_validator
    def remember(ctx: RunContext, output: str) -> str:
        observed.append(ctx)
        return output

    async def run():
        response = await GalaxieModel('direct').request([], None, ModelRequestParameters())
        assert response.parts == [TextPart('direct')]
        first = await run_child(context, child, 'child')
        second = await run_child(context, child, 'child')
        assert first.output == second.output == 'child'
        assert first.conversation.conversation_id == second.conversation.conversation_id != 'fixed'

    asyncio.run(run())
    assert context.usage.requests == 2
    assert all(ctx.usage is context.usage and ctx.usage_limits is context.usage_limits and ctx.deps is context.deps for ctx in observed)
    assert observed[0].run_id != observed[1].run_id


def test_child_requires_a_real_tool_call_position():
    seen = []
    install_replies([], seen)
    context = replace(tool_context(), tool_call_id='missing')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run_child(context, Agent(GalaxieModel('child')), 'child'))
    assert error.value.code == 'invalid'
    assert seen == []


def test_delegation_uses_no_private_pydantic_ai_module_imports():
    source = Path(__file__).parents[1] / 'src' / 'galaxie' / 'pydantic_ai.py'
    imports = []
    for node in ast.walk(ast.parse(source.read_text())):
        if isinstance(node, ast.ImportFrom):
            imports.append(node.module)
        elif isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
    assert not [module for module in imports if module and module.startswith('pydantic_ai.')
                and any(part.startswith('_') for part in module.split('.')[1:])]
