# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import subprocess
import sys

import dspy
import pytest
from dspy.lm15 import Config, FunctionTool, Message, Request, TextPart, ToolCallPart

from galaxie import GalaxieError, _bridge
from galaxie.dspy import Executor, GalaxieLM, capability_tool, prepare_executor, error_code


def fields(**values):
    return '\n'.join(f'[[ ## {key} ## ]]\n{value}' for key, value in values.items()) + '\n[[ ## completed ## ]]'


def transport_for(replies, seen=None, code=None):
    replies = iter(replies)
    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append(message)
        response = {key: message[key] for key in ('v', 'id', 'op')}
        if code:
            return json.dumps({**response, 'kind': 'response', 'ok': False, 'error': {'code': code}})
        return json.dumps({**response, 'kind': 'response', 'ok': True, 'payload': next(replies)})
    _bridge.install_transport(transport)


def predictor(adapter=None):
    module = dspy.Predict('question -> answer')
    module.set_lm(GalaxieLM('answer'))
    return Executor(module, adapter=adapter)


@pytest.mark.parametrize('adapter,reply', [(None, fields(answer='Paris')), (dspy.JSONAdapter(), '{"answer":"Paris"}')])
def test_predict_and_json_parse_only_bridged_text(adapter, reply):
    seen = []
    transport_for([{'content': reply}], seen)
    assert asyncio.run(predictor(adapter).run({'question': 'France?'}, 'conversation', 5)) == {'answer': 'Paris'}
    payload = seen[0]['payload']
    assert payload['role'] == 'answer'
    assert [message['role'] for message in payload['messages']] == ['system', 'user']
    assert payload['options'] == {}


@pytest.mark.parametrize('code', ['denied', 'cancelled', 'budget_exceeded', 'unavailable'])
def test_model_failures_keep_the_galaxie_code(code):
    transport_for([], code=code)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(predictor().run({'question': 'private question'}, 'c', 5))
    assert error.value.code == code
    assert 'private question' not in str(error.value)


@pytest.mark.parametrize('config', [{'n': 2}, {'temperature': 0.5}, {'max_tokens': 8}, {'top_p': 0.8}])
def test_unsupported_settings_fail_before_dispatch(config):
    seen = []
    transport_for([], seen)
    module = dspy.Predict('question -> answer', **config)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module).run({'question': 'q'}, 'c', 5))
    assert error.value.code == 'unsupported'
    assert seen == []


def tool_call(identifier='one', name='lookup'):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': '{"query":"France"}'}}


def native_request():
    return Request(model='answer', system='system', messages=(Message.user('question'),), tools=(FunctionTool('lookup', 'Look up', {'type': 'object'}),), config=Config())


def test_native_tool_definitions_calls_and_usage_reuse_bridge_fields():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call()], 'usage': {'input_tokens': 2, 'output_tokens': 3, 'total_tokens': 5}}], seen)
    response = asyncio.run(GalaxieLM('answer', native_tools=True).acall(native_request()))
    assert response.message.parts == (ToolCallPart(id='one', name='lookup', input={'query': 'France'}),)
    assert response.usage.total_tokens == 5
    assert seen[0]['payload']['options']['tools'] == [{'type': 'function', 'function': {'name': 'lookup', 'description': 'Look up', 'parameters': {'type': 'object'}}}]


@pytest.mark.parametrize('calls', [[tool_call('')], [tool_call('x' * 129)], [tool_call(name='missing')], [tool_call(), tool_call()]])
def test_invalid_native_tool_identity_is_refused(calls):
    transport_for([{'content': '', 'toolCalls': calls}])
    with pytest.raises(dspy.LMError) as error:
        asyncio.run(GalaxieLM('answer', native_tools=True).acall(native_request()))
    assert error.value.code == 'invalid'


def test_native_tool_id_cannot_repeat_an_earlier_assistant_call():
    transport_for([{'content': '', 'toolCalls': [tool_call()]}])
    request = native_request()
    request = Request(model=request.model, messages=(Message(role='assistant', parts=(ToolCallPart(id='one', name='lookup', input={}),)),), tools=request.tools)
    with pytest.raises(dspy.LMError) as error:
        asyncio.run(GalaxieLM('answer', native_tools=True).acall(request))
    assert error.value.code == 'invalid'


def test_default_lm_refuses_native_calls_and_invalid_usage():
    for reply, code in [({'content': '', 'toolCalls': [tool_call()]}, 'unsupported'), ({'content': 'answer', 'usage': {'input_tokens': 2, 'output_tokens': 2, 'total_tokens': 3}}, 'invalid')]:
        transport_for([reply])
        with pytest.raises(dspy.LMError) as error:
            asyncio.run(GalaxieLM('answer').acall(Request(model='answer', messages=(Message.user('q'),))))
        assert error.value.code == code


def test_synchronous_calls_are_unsupported_and_imports_have_no_provider():
    with pytest.raises(dspy.LMError) as error:
        GalaxieLM('answer')('question')
    assert error.value.code == 'unsupported'
    subprocess.run([sys.executable, '-I', '-c', "import galaxie.dspy,sys; assert 'openai' not in sys.modules; assert 'litellm' not in sys.modules"], check=True)


SCHEMA = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}


class Question(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


@pytest.mark.parametrize('kind', ['react', 'react-v2'])
@pytest.mark.parametrize('code', ['denied', 'outcome_unknown'])
def test_terminal_capability_errors_escape_both_react_loops(kind, code):
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        if message['op'] == 'capability':
            return json.dumps({**{key: message[key] for key in ('v', 'op', 'id')}, 'kind': 'response', 'ok': False, 'error': {'code': code}})
        text = fields(next_thought='look up', next_tool_name='lookup', next_tool_args='{"query":"France"}') if kind == 'react' else fields(next_thought='look up', tool_calls='[{"name":"lookup","args":{"query":"France"}}]')
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': text}})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup@1', 'Look up', SCHEMA, tool_name='lookup')
    module = (dspy.ReAct if kind == 'react' else dspy.ReActV2)(Question, tools=[tool], max_iters=2)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module).run({'question': 'q'}, 'conversation', 5))
    assert error.value.code == code
    assert [message['op'] for message in seen] == ['model', 'capability']
    assert seen[-1]['payload'] == {'name': 'lookup@1', 'input': {'query': 'France'}, 'effectScope': 'dspy/conversation/1/0'}


def test_concurrent_capability_positions_follow_call_start_order():
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['payload'])
        if len(seen) == 1:
            await asyncio.sleep(0)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': 'ok'})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup@1', 'Look up', SCHEMA)
    class Program(dspy.Module):
        async def aforward(self):
            await asyncio.gather(tool.acall(query='first'), tool.acall(query='second'))
            return dspy.Prediction(answer='done')
    executor = Executor(Program())
    assert asyncio.run(executor.run({}, 'c', 5)) == {'answer': 'done'}
    assert [item['effectScope'] for item in seen] == ['dspy/c/1/0', 'dspy/c/1/1']
    asyncio.run(executor.run({}, 'c', 5))
    assert seen[2]['effectScope'] == 'dspy/c/2/0'


def test_callbacks_plain_lms_and_json_fallback_are_refused():
    for mutation in ['lm', 'callbacks', 'fallback']:
        module = dspy.Predict('question -> answer')
        module.set_lm(dspy.LM('openai/x') if mutation == 'lm' else GalaxieLM('answer'))
        if mutation == 'callbacks':
            module.callbacks = [object()]
        with pytest.raises(GalaxieError) as error:
            Executor(module, adapter=dspy.ChatAdapter() if mutation == 'fallback' else None)
        assert error.value.code == 'unsupported'
    with pytest.raises(GalaxieError):
        prepare_executor(object())


def test_fixed_errors_and_no_history_trace_or_callbacks(tmp_path, monkeypatch):
    monkeypatch.setenv('DSPY_CACHEDIR', str(tmp_path))
    seen = []
    transport_for([{'content': fields(answer='private answer')}], seen)
    notifications = []
    original = _bridge._transport
    assert original is not None
    _bridge.install_transport(original, notifications.append)
    executor = predictor()
    assert asyncio.run(executor.run({'question': 'private prompt'}, 'c', 5)) == {'answer': 'private answer'}
    from dspy.clients.base_lm import GLOBAL_HISTORY
    assert GLOBAL_HISTORY == []
    lm = executor.module.get_lm()
    assert isinstance(lm, GalaxieLM)
    assert lm.history == []
    assert not dspy.settings.trace
    assert notifications == []
    assert list(tmp_path.iterdir()) == []
    class Broken(dspy.Module):
        async def aforward(self):
            raise RuntimeError('private author exception')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Broken()).run({}, 'c', 5))
    assert (error.value.code, str(error.value)) == ('executor_error', 'The executor or agent code failed.')


def test_sync_module_is_refused_before_author_code_runs():
    class SyncProgram(dspy.Module):
        def forward(self):
            raise AssertionError('Synchronous author code ran.')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(SyncProgram()).run({}, 'c', 5))
    assert error.value.code == 'unsupported'


def react_transport(seen, model_replies, capability_code=None, model_code_after=None):
    replies = iter(model_replies)
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        response = {key: message[key] for key in ('v', 'id', 'op')}
        models = sum(1 for item in seen if item['op'] == 'model')
        if message['op'] == 'capability' and capability_code:
            return json.dumps({**response, 'kind': 'response', 'ok': False, 'error': {'code': capability_code}})
        if message['op'] == 'model' and model_code_after is not None and models > model_code_after:
            return json.dumps({**response, 'kind': 'response', 'ok': False, 'error': {'code': 'denied'}})
        return json.dumps({**response, 'kind': 'response', 'ok': True, 'payload': next(replies)})
    _bridge.install_transport(transport)


LOOKUP = {'content': fields(next_thought='look up', next_tool_name='lookup', next_tool_args='{"query":"France"}')}
FINISH = {'content': fields(reasoning='Done.', answer='Paris')}


def test_invalid_capability_failure_ends_the_run_because_a_write_may_have_run():
    seen = []
    react_transport(seen, [LOOKUP, FINISH], capability_code='invalid')
    tool = capability_tool('lookup@1', 'Look up', SCHEMA, tool_name='lookup')
    module = dspy.ReAct(Question, tools=[tool], max_iters=2)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module).run({'question': 'q'}, 'c', 5))
    assert error.value.code == 'invalid'
    assert [message['op'] for message in seen] == ['model', 'capability']


def test_failures_inside_author_tools_still_end_the_run_with_their_code():
    from galaxie import capabilities
    inner = dspy.Predict('question -> answer')
    inner.set_lm(GalaxieLM('answer'))
    async def nested(query: str) -> str:
        return (await inner.acall(question=query)).answer
    async def direct(query: str) -> str:
        return await capabilities.call('write@1', {'query': query})
    for tool, kwargs, code in [(nested, {'model_code_after': 1}, 'denied'), (direct, {'capability_code': 'outcome_unknown'}, 'outcome_unknown')]:
        seen = []
        react_transport(seen, [LOOKUP, FINISH, FINISH], **kwargs)
        module = dspy.ReAct(Question, tools=[dspy.Tool(tool, name='lookup')], max_iters=2)
        module.set_lm(GalaxieLM('answer'))
        with pytest.raises(GalaxieError) as error:
            asyncio.run(Executor(module).run({'question': 'q'}, 'c', 5))
        assert error.value.code == code
        assert [message['op'] for message in seen] == ['model', 'model' if tool is nested else 'capability']


def test_grouped_failures_keep_first_galaxie_code_and_omit_exception_text():
    from galaxie.dspy import _LMError, _Termination
    assert error_code(BaseExceptionGroup('private group', [asyncio.CancelledError(), _Termination('denied')])) == 'denied'
    assert error_code(ExceptionGroup('private group', [_LMError('budget_exceeded'), GalaxieError('unavailable')])) == 'budget_exceeded'
    assert error_code(BaseExceptionGroup('private group', [asyncio.CancelledError()])) == 'cancelled'
    assert error_code(ExceptionGroup('private group', [RuntimeError('private exception')])) == 'executor_error'
