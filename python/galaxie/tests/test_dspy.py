# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import contextvars
import gc
import json
import subprocess
import sys
import threading

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


@pytest.mark.parametrize('kind,threads,caught,max_errors', [
    ('parallel', 3, Exception, 10),
    ('parallel', 3, BaseException, 10),
    ('parallel', 3, BaseException, 1),
    ('parallel', 1, Exception, 10),
    ('parallel', None, BaseException, 10),
    ('evaluate', 2, BaseException, 10),
    ('evaluate', None, Exception, 10),
    ('async', 2, BaseException, 10),
])
def test_thread_pool_refusal_survives_author_catches_and_cleans_up(kind, threads, caught, max_errors):
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question -> answer')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            if question == 'supported':
                return await self.predict.acall(question=question)
            examples = [dspy.Example(question=str(index), answer='ok').with_inputs('question') for index in range(3)]
            try:
                if kind == 'evaluate':
                    dspy.Evaluate(devset=examples, num_threads=threads, display_progress=False, display_table=False)(self.predict, metric=lambda *_: 1)
                else:
                    def call(question):
                        return asyncio.run(self.predict.acall(question=question))
                    dspy.Parallel(num_threads=threads, max_errors=max_errors, disable_progress_bar=True)([(call if kind == 'async' else self.predict, example) for example in examples])
            except caught:
                pass
            return dspy.Prediction(answer='fallback')

    seen = []
    transport_for([], seen)
    executor = Executor(Program())
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'question': 'refused'}, 'c', 5))
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []
    assert dspy.settings.get('galaxie_run') is None
    transport_for([{'content': fields(answer='ok')}], seen)
    assert asyncio.run(executor.run({'question': 'supported'}, 'c', 5)) == {'answer': 'ok'}
    assert len(seen) == 1
    assert dspy.settings.get('galaxie_run') is None


@pytest.mark.parametrize('engine', ['complete', 'stream', 'sync'])
def test_foreign_dspy_settings_refuse_engine_entry_before_dispatch(engine):
    from dspy.dsp.utils.settings import dotdict, thread_local_overrides
    from galaxie.dspy import _AsyncEngine, _SyncEngine

    class Program(dspy.Module):
        async def aforward(self):
            parent = thread_local_overrides.get().copy()
            async def foreign():
                thread_local_overrides.set(dotdict(parent))
                if engine == 'sync':
                    _SyncEngine().complete(native_request())
                elif engine == 'stream':
                    async for _ in _AsyncEngine('answer', True).stream(native_request()):
                        pass
                else:
                    await _AsyncEngine('answer', True).complete(native_request())
            task = asyncio.create_task(foreign(), context=contextvars.Context())
            try:
                await task
            except BaseException:
                pass
            return dspy.Prediction(answer='fallback')

    seen = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program()).run({}, 'c', 5))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('grouped', [False, True])
def test_failed_thread_start_is_unsupported_without_matching_error_text(monkeypatch, grouped):
    def boom(*args, **kwargs):
        raise RuntimeError('private thread failure')
    monkeypatch.setattr(threading, '_start_joinable_thread', boom)

    class Program(dspy.Module):
        async def aforward(self):
            try:
                dspy.Parallel(num_threads=2, disable_progress_bar=True)([(lambda: None, {})])
            except RuntimeError as error:
                if grouped:
                    raise ExceptionGroup('private group', [error])
                raise

    seen = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program()).run({}, 'c', 5))
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []


def test_documented_raw_thread_and_stale_settings_limits():
    from dspy.dsp.utils.settings import thread_local_overrides
    captured = []
    failures = []

    def worker(overrides=None):
        if overrides is not None:
            thread_local_overrides.set(overrides)
        try:
            GalaxieLM('answer')('q')
        except dspy.LMError as error:
            failures.append(error.code)

    class Program(dspy.Module):
        async def aforward(self):
            captured.append(thread_local_overrides.get().copy())
            thread = threading.Thread(target=worker)
            thread.start()
            thread.join()
            return dspy.Prediction(answer='fallback')

    seen = []
    transport_for([], seen)
    assert asyncio.run(Executor(Program()).run({}, 'c', 5)) == {'answer': 'fallback'}
    gc.collect()
    assert captured[0]['galaxie_run']() is None

    class Later(dspy.Module):
        async def aforward(self):
            thread = threading.Thread(target=worker, args=(captured[0],))
            thread.start()
            thread.join()
            return dspy.Prediction(answer='later')

    assert asyncio.run(Executor(Later()).run({}, 'c', 5)) == {'answer': 'later'}
    assert failures == ['unsupported', 'unsupported']
    assert seen == []
    assert dspy.settings.get('galaxie_run') is None


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
    assert seen[-1]['payload'] == {'name': 'lookup@1', 'input': {'query': 'France'}, 'effectScope': 'dspy/conversation/1/0', 'tool': True}


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


@pytest.mark.parametrize('streaming', [False, True])
def test_invalid_capability_failure_ends_the_run_because_a_write_may_have_run(streaming):
    seen = []
    react_transport(seen, [LOOKUP, FINISH], capability_code='invalid')
    tool = capability_tool('lookup@1', 'Look up', SCHEMA, tool_name='lookup')
    module = dspy.ReAct(Question, tools=[tool], max_iters=2)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module, stream_fields=['answer'] if streaming else []).run({'question': 'q'}, 'c', 5, on_stream=lambda *_: None))
    assert error.value.code == 'invalid'
    assert [message['op'] for message in seen] == ['model', 'capability']


@pytest.mark.parametrize('streaming', [False, True])
def test_failures_inside_author_tools_still_end_the_run_with_their_code(streaming):
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
            asyncio.run(Executor(module, stream_fields=['answer'] if streaming else []).run({'question': 'q'}, 'c', 5, on_stream=lambda *_: None))
        assert error.value.code == code
        assert [message['op'] for message in seen] == ['model', 'model' if tool is nested else 'capability']


def test_grouped_failures_keep_first_galaxie_code_and_omit_exception_text():
    from galaxie.dspy import _LMError, _Termination
    assert error_code(BaseExceptionGroup('private group', [asyncio.CancelledError(), _Termination('denied')])) == 'denied'
    assert error_code(ExceptionGroup('private group', [_LMError('budget_exceeded'), GalaxieError('unavailable')])) == 'budget_exceeded'
    assert error_code(BaseExceptionGroup('private group', [asyncio.CancelledError()])) == 'cancelled'
    assert error_code(ExceptionGroup('private group', [RuntimeError('private exception')])) == 'executor_error'


def stream_transport(chunks, *, final=None, code=None, seen=None):
    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append(message)
        for text in chunks:
            _bridge.receive_model_chunk(json.dumps({
                **{key: message[key] for key in ('v', 'id')}, 'kind': 'notify',
                'op': 'model-chunk', 'payload': {'content': text} if isinstance(text, str) else text,
            }))
            await asyncio.sleep(0)
        response = {key: message[key] for key in ('v', 'id', 'op')}
        return json.dumps({**response, 'kind': 'response', **(
            {'ok': False, 'error': {'code': code}} if code else
            {'ok': True, 'payload': final if isinstance(final, dict) else {'content': ''.join(chunks) if final is None else final}}
        )})
    _bridge.install_transport(transport)


@pytest.mark.parametrize('fragmented', [False, True])
def test_streamify_emits_only_declared_checked_field_text_in_order(monkeypatch, fragmented):
    import dspy.streaming.messages as status
    monkeypatch.setattr(status, 'sync_send_to_stream', lambda *_: pytest.fail('Streaming used the threaded status sender.'))
    seen, events = [], []
    chunks = ['[[ ## reasoning ## ]]\nHidden rationale.\n', '[[ ## answer ## ]]\n', 'Pa', 'ris', '\n[[ ## completed ## ]]']
    stream_transport(list(''.join(chunks)) if fragmented else chunks, seen=seen)
    module = dspy.ChainOfThought(Question)
    module.set_lm(GalaxieLM('answer'))
    executor = Executor(module, stream_fields=['answer'])
    result = asyncio.run(executor.run({'question': 'France?'}, 'c', 5, on_stream=lambda mode, data: events.append((mode, data))))
    assert result == {'reasoning': 'Hidden rationale.', 'answer': 'Paris'}
    assert seen[0]['payload']['options'] == {'stream': True}
    texts = [data for mode, data in events if mode == 'messages']
    assert texts
    assert all(set(data) == {'field', 'text'} and data['field'] == 'answer' for data in texts)
    assert ''.join(data['text'] for data in texts) == 'Paris'
    assert [data for mode, data in events if mode == 'updates'] == [{'kind': 'model', 'index': 0}]


@pytest.mark.parametrize('final,code,expected', [('different final reply', None, 'invalid'), (None, 'denied', 'denied')])
def test_stream_failure_keeps_fixed_code_and_previously_emitted_text(final, code, expected):
    stream_transport(['[[ ## answer ## ]]\n', 'safe prefix', ' still safe'], final=final, code=code)
    module = dspy.Predict(Question)
    module.set_lm(GalaxieLM('answer'))
    events = []
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module, stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda mode, data: events.append((mode, data))))
    assert error.value.code == expected
    assert 'safe prefix' not in str(error.value)
    assert any(mode == 'messages' for mode, _ in events)


def test_json_adapter_streaming_is_refused_before_any_model_call():
    seen = []
    transport_for([], seen)
    module = dspy.Predict(Question)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module, adapter=dspy.JSONAdapter(), stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda *_: None))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('streamed', [
    {'id': 'one', 'function': {'name': 'lookup', 'arguments': '{"query":"Fran'}},
    {'id': 'other', 'function': {'name': 'lookup', 'arguments': '{"query":"France"}'}},
    {'id': 'one', 'function': {'name': 'other', 'arguments': '{"query":"France"}'}},
    {'id': 'one', 'function': {'name': 'lookup', 'arguments': '{"query":"Germany"}'}},
])
def test_streamed_tool_calls_must_match_the_checked_final_reply(streamed):
    stream_transport([{'content': '', 'toolCalls': [{'index': 0, **streamed}]}], final={'content': '', 'toolCalls': [tool_call()]})
    class Sink:
        async def send(self, chunk):
            pass
    async def run():
        with dspy.context(send_stream=Sink()):
            return await GalaxieLM('answer', native_tools=True).acall(native_request())
    with pytest.raises(dspy.LMError) as error:
        asyncio.run(run())
    assert error.value.code == 'invalid'


def test_streamed_tool_calls_accept_fragmented_escaped_arguments_and_settle_usage():
    chunks = [
        {'content': '', 'toolCalls': [{'index': 0, 'id': 'one', 'function': {'name': 'look', 'arguments': '{"query":"Fr'}}]},
        {'content': '', 'toolCalls': [{'index': 0, 'function': {'name': 'up', 'arguments': 'an\\u0063e"}'}}]},
    ]
    stream_transport(chunks, final={'content': '', 'toolCalls': [tool_call()], 'usage': {'input_tokens': 2, 'output_tokens': 3, 'total_tokens': 5}})
    class Sink:
        async def send(self, chunk):
            pass
    async def run():
        with dspy.context(send_stream=Sink()):
            return await GalaxieLM('answer', native_tools=True).acall(native_request())
    result = asyncio.run(run())
    assert result.message.parts == (ToolCallPart(id='one', name='lookup', input={'query': 'France'}),)
    assert result.usage.total_tokens == 5


def test_stream_notification_failure_drains_streamify_in_its_own_task(caplog):
    stream_transport(['[[ ## answer ## ]]\n', 'Paris', '\n[[ ## completed ## ]]'])
    module = dspy.Predict(Question)
    module.set_lm(GalaxieLM('answer'))
    def notify(mode, data):
        if mode == 'messages':
            raise GalaxieError('unsupported')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module, stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=notify))
    assert error.value.code == 'unsupported'
    assert 'unhandled exception' not in caplog.text


@pytest.mark.parametrize('answer', ['Use [[Paris]] today', 'hello [[ ## fake ## ]] world', 'An array [[1,2]] is nested.', 'first\r\nsecond', 'first\rsecond', 'first\u2028second'])
@pytest.mark.parametrize('fragmented', [False, True])
def test_streamify_preserves_literal_brackets_and_inline_headers(answer, fragmented):
    text = fields(answer=answer)
    stream_transport(list(text) if fragmented else [text])
    module = dspy.Predict(Question)
    module.set_lm(GalaxieLM('answer'))
    events = []
    result = asyncio.run(Executor(module, stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda mode, data: events.append((mode, data))))
    expected = '\n'.join(answer.splitlines())
    assert result['answer'] == expected
    assert ''.join(data['text'] for mode, data in events if mode == 'messages') == expected


@pytest.mark.parametrize('fragmented', [False, True])
def test_indented_field_header_is_left_to_the_final_output(fragmented):
    text = '  [[ ## answer ## ]]\nParis\n[[ ## completed ## ]]'
    stream_transport(list(text) if fragmented else ['  ', '[[ ## answer ## ]]', '\nParis\n', '[[ ## completed ## ]]'])
    module = dspy.Predict(Question)
    module.set_lm(GalaxieLM('answer'))
    events = []
    result = asyncio.run(Executor(module, stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda mode, data: events.append((mode, data))))
    assert result == dspy.ChatAdapter().parse(Question, text)
    assert [data for mode, data in events if mode == 'messages'] == []


def test_streamify_reuses_listener_on_later_model_calls():
    replies = iter(['first draft', 'final answer'])
    async def transport(raw):
        message = json.loads(raw)
        text = fields(answer=next(replies))
        for content in [text]:
            _bridge.receive_model_chunk(json.dumps({
                **{key: message[key] for key in ('v', 'id')}, 'kind': 'notify',
                'op': 'model-chunk', 'payload': {'content': content},
            }))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': text}})
    _bridge.install_transport(transport)
    class Refine(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self, question):
            await self.predict.acall(question=question)
            return await self.predict.acall(question=question)
    events = []
    result = asyncio.run(Executor(Refine(), stream_fields=['answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda mode, data: events.append((mode, data))))
    assert result == {'answer': 'final answer'}
    assert [data['text'] for mode, data in events if mode == 'messages'] == ['first draft', 'final answer']


@pytest.mark.parametrize('declaration', ['missing', 'non-text', 'ambiguous'])
def test_stream_fields_must_name_unique_text_outputs_before_dispatch(declaration):
    seen = []
    transport_for([], seen)
    class Program(dspy.Module):
        def __init__(self):
            self.first = dspy.Predict('question -> answer: int' if declaration == 'non-text' else Question)
            self.first.set_lm(GalaxieLM('answer'))
            if declaration == 'ambiguous':
                self.second = dspy.Predict(Question)
                self.second.set_lm(GalaxieLM('answer'))
        async def aforward(self, question):
            raise AssertionError('An invalid stream declaration reached author code.')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program(), stream_fields=['absent' if declaration == 'missing' else 'answer']).run({'question': 'q'}, 'c', 5, on_stream=lambda *_: None))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_two_pauses_replay_models_direct_capabilities_and_writes_without_dispatch():
    from galaxie.dspy import request_interaction
    from galaxie import capabilities
    seen = []
    transport_for([{'content': fields(answer='Paris')}, 'receipt', {'content': fields(answer='Done')}], seen)
    interaction = {'surfaceId': 'main', 'viewRevision': 'review', 'component': 'test.Review/v1', 'props': {}}
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self, question):
            prediction = await self.predict.acall(question=question)
            await capabilities.call('write@1', {'query': prediction.answer})
            first = request_interaction(interaction)
            second = request_interaction({**interaction, 'viewRevision': 'second'})
            final = await self.predict.acall(question=second['payload'])
            return dspy.Prediction(answer=final.answer, first=first, second=second)
    executor = Executor(Program())
    assert asyncio.run(executor.run({'question': 'France?'}, 'c', 5)) is None
    first = executor.pending('c')
    assert first is not None and first['value'] == interaction
    assert asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': first['id'], 'action': 'keep', 'payload': 'one'})) is None
    second = executor.pending('c')
    assert second is not None and second['id'] != first['id']
    result = asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': second['id'], 'action': 'keep', 'payload': 'two'}))
    assert result == {'answer': 'Done', 'first': {'action': 'keep', 'payload': 'one'}, 'second': {'action': 'keep', 'payload': 'two'}}
    assert [message['op'] for message in seen] == ['model', 'capability', 'model']
    assert seen[1]['payload']['effectScope'] == 'dspy/c/1/0'
    assert executor.pending('c') is None


INTERACTION = {'surfaceId': 'main', 'viewRevision': 'review', 'component': 'test.Review/v1', 'props': {}}


def test_session_snapshot_rederives_pending_and_replays_in_a_fresh_executor():
    from galaxie.dspy import request_interaction
    from galaxie import capabilities
    class Program(dspy.Module):
        async def aforward(self, question):
            receipt = await capabilities.call('write@1', {'query': question})
            answer = request_interaction(INTERACTION)
            return dspy.Prediction(answer=answer['payload'], receipt=receipt)
    seen = []
    transport_for(['private receipt'], seen)
    original = Executor(Program())
    asyncio.run(original.run({'question': 'private input'}, 'conversation', 5))
    pending = original.pending('conversation')
    assert pending is not None
    checkpoint, metadata = original._snapshot('conversation', 'session')
    restored = Executor(Program())
    assert restored._restore(checkpoint, metadata, 'session') == 'conversation'
    assert restored.pending('conversation') == pending
    assert asyncio.run(restored.run(None, 'conversation', 5, resume={
        'interactionId': pending['id'], 'action': 'continue', 'payload': 'done',
    })) == {'answer': 'done', 'receipt': 'private receipt'}
    assert len(seen) == 1
    assert seen[0]['payload']['effectScope'] == 'dspy/conversation/1/0'
    completed = Executor(Program())
    completed._restore(*restored._snapshot('conversation', 'session'), 'session')
    assert completed.pending('conversation') is None
    transport_for(['new receipt'], seen)
    asyncio.run(completed.run({'question': 'new run'}, 'conversation', 5))
    assert seen[-1]['payload']['effectScope'] == 'dspy/conversation/2/0'


@pytest.mark.parametrize('mutation', ['session', 'version', 'format', 'adapter', 'digest', 'pending', 'counter', 'bytes'])
def test_corrupt_or_incompatible_snapshots_do_not_replace_a_valid_session(mutation):
    from galaxie.dspy import request_interaction
    class Program(dspy.Module):
        async def aforward(self):
            return dspy.Prediction(answer=request_interaction(INTERACTION))
    executor = Executor(Program())
    asyncio.run(executor.run({}, 'c', 5))
    checkpoint, metadata = executor._snapshot('c', 'session')
    raw, meta = json.loads(checkpoint), json.loads(metadata)
    if mutation == 'session': meta['session'] = 'other'
    if mutation == 'version': meta['dspy'] = '0.0.0'
    if mutation == 'format': meta['v'] = 2
    if mutation == 'adapter': meta['adapter'] = 'JSONAdapter'
    if mutation == 'digest': raw['journal'][-1]['digest'] = '0' * 64
    if mutation == 'pending': raw['journal'][-1]['request']['props'] = {'changed': True}
    if mutation == 'counter': raw['pauses'] = 0
    before = executor.pending('c')
    with pytest.raises(GalaxieError) as error:
        executor._restore(b'corrupt' if mutation == 'bytes' else json.dumps(raw).encode(), json.dumps(meta).encode(), 'session')
    assert error.value.code == 'unrecoverable'
    assert executor.pending('c') == before


@pytest.mark.parametrize('change', ['model', 'write', 'return', 'interaction'])
def test_divergence_is_terminal_before_any_live_call_or_output(change):
    from galaxie.dspy import request_interaction
    from galaxie import capabilities
    changed = False
    seen, events = [], []
    transport_for([{'content': fields(answer='Paris')}, 'receipt'], seen)
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self):
            if changed and change == 'return':
                return dspy.Prediction(answer='early')
            await self.predict.acall(question='different' if changed and change == 'model' else 'same')
            await capabilities.call('write@1', {'query': 'different' if changed and change == 'write' else 'same'})
            request_interaction({**INTERACTION, 'viewRevision': 'different'} if changed and change == 'interaction' else INTERACTION)
            return dspy.Prediction(answer='done')
    executor = Executor(Program())
    asyncio.run(executor.run({}, 'c', 5))
    pending = executor.pending('c')
    assert pending is not None
    changed = True
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': pending['id'], 'action': 'keep', 'payload': {}}, on_stream=lambda *item: events.append(item)))
    assert error.value.code == 'unrecoverable'
    assert len(seen) == 2
    assert events == [('updates', {'kind': 'unrecoverable'})]
    with pytest.raises(GalaxieError) as error:
        executor.pending('c')
    assert error.value.code == 'unrecoverable'
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({}, 'c', 5))
    assert error.value.code == 'unrecoverable'


def test_stale_resume_leaves_the_pending_answer_and_journal_intact():
    from galaxie.dspy import request_interaction
    entries = []
    class Program(dspy.Module):
        async def aforward(self):
            entries.append('run')
            return dspy.Prediction(answer=request_interaction(INTERACTION))
    executor = Executor(Program())
    asyncio.run(executor.run({}, 'c', 5))
    pending = executor.pending('c')
    assert pending is not None
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': 'wrong', 'action': 'keep', 'payload': {}}))
    assert error.value.code == 'stale'
    assert entries == ['run']
    assert executor.pending('c') == pending
    result = asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': pending['id'], 'action': 'keep', 'payload': 'answer'}))
    assert result == {'answer': {'action': 'keep', 'payload': 'answer'}}


@pytest.mark.parametrize('streaming', [False, True])
def test_replay_is_silent_and_returns_mutation_isolated_receipts(streaming):
    from galaxie.dspy import request_interaction
    from galaxie import capabilities
    seen, events = [], []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        payload = {'content': fields(answer='private reply')} if message['op'] == 'model' else {'receipt': ['original']}
        if message['op'] == 'model' and streaming:
            _bridge.receive_model_chunk(json.dumps({**{key: message[key] for key in ('v', 'id')}, 'kind': 'notify', 'op': 'model-chunk', 'payload': payload}))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': payload})
    _bridge.install_transport(transport)
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self):
            await self.predict.acall(question='same')
            receipt = await capabilities.call('write@1', {})
            receipt['receipt'].append('author mutation')
            answer = request_interaction(INTERACTION)
            return dspy.Prediction(receipt=receipt, answer=answer)
    executor = Executor(Program(), stream_fields=['answer'] if streaming else [])
    asyncio.run(executor.run({}, 'c', 5, on_stream=lambda *item: events.append(item)))
    pending = executor.pending('c')
    assert pending is not None
    events.clear()
    result = asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': pending['id'], 'action': 'keep', 'payload': {}}, on_stream=lambda *item: events.append(item)))
    assert result['receipt'] == {'receipt': ['original', 'author mutation']}
    assert [message['op'] for message in seen] == ['model', 'capability']
    assert events == [('updates', {'kind': 'replayed', 'count': 3})]


def test_pause_groups_allow_one_pause_with_cancellation_but_reject_two_or_other_errors():
    from galaxie.dspy import _Pause
    for children, expected in [
        ([_Pause({'id': 'one', 'value': INTERACTION}), asyncio.CancelledError()], None),
        ([_Pause({}), _Pause({})], 'unsupported'),
        ([_Pause({}), ValueError('private text')], 'executor_error'),
        ([_Pause({}), GalaxieError('denied'), GalaxieError('unavailable')], 'denied'),
    ]:
        class Program(dspy.Module):
            async def aforward(self):
                raise BaseExceptionGroup('private group', children)
        executor = Executor(Program(), output=lambda _: {})
        if expected is None:
            assert asyncio.run(executor.run({}, 'c', 5)) is None
            assert executor.pending('c') == {'id': 'one', 'value': INTERACTION}
        else:
            with pytest.raises(GalaxieError) as error:
                asyncio.run(executor.run({}, 'c', 5))
            assert error.value.code == expected


@pytest.mark.parametrize('value', [
    {}, {**INTERACTION, 'extra': True}, {**INTERACTION, 'component': 'wrong'},
    {**INTERACTION, 'props': {'bad': float('nan')}}, {**INTERACTION, 'props': {'bad': (1, 2)}},
])
def test_pause_requests_obey_the_json_display_contract(value):
    from galaxie.dspy import request_interaction
    class Program(dspy.Module):
        async def aforward(self):
            request_interaction(value)
    executor = Executor(Program())
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({}, 'c', 5))
    assert error.value.code == 'unsupported'
    assert executor.pending('c') is None


def test_concurrent_replayed_capabilities_keep_call_start_order():
    from galaxie.dspy import request_interaction
    from galaxie import capabilities
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        if message['payload']['input']['query'] == 'first':
            await asyncio.sleep(0)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': message['payload']['input']['query']})
    _bridge.install_transport(transport)
    class Program(dspy.Module):
        async def aforward(self):
            results = await asyncio.gather(capabilities.call('write@1', {'query': 'first'}), capabilities.call('write@1', {'query': 'second'}))
            request_interaction(INTERACTION)
            return dspy.Prediction(results=results)
    executor = Executor(Program())
    asyncio.run(executor.run({}, 'c', 5))
    pending = executor.pending('c')
    assert pending is not None
    assert asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': pending['id'], 'action': 'keep', 'payload': {}})) == {'results': ['first', 'second']}
    assert [message['payload']['effectScope'] for message in seen] == ['dspy/c/1/0', 'dspy/c/1/1']


@pytest.mark.parametrize('kwargs', [{'name': '', 'input': {}}, {'name': 'write@1', 'input': {}, 'effect_scope': ''}])
def test_caught_capability_validation_failure_still_ends_the_run_before_a_model(kwargs):
    from galaxie import capabilities
    seen = []
    transport_for([], seen)
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self):
            try:
                await capabilities.call(**kwargs)
            except GalaxieError:
                pass
            return await self.predict.acall(question='must not dispatch')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program()).run({}, 'c', 5))
    assert error.value.code == 'invalid'
    assert seen == []


def test_direct_capability_names_are_not_projected_as_offered_tool_names():
    from galaxie import capabilities
    events = []
    transport_for([], code='denied')
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict(Question)
            self.predict.set_lm(GalaxieLM('answer'))
        async def aforward(self):
            await capabilities.call('private-dynamic-name@1', {'query': 'private argument'})
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program(), stream_fields=['answer']).run({}, 'c', 5, on_stream=lambda *item: events.append(item)))
    assert error.value.code == 'denied'
    assert events == []


def test_a_fresh_start_replaces_a_pending_pause_that_core_discarded():
    from galaxie.dspy import request_interaction
    class Program(dspy.Module):
        async def aforward(self, ask):
            return dspy.Prediction(answer=request_interaction(INTERACTION)['payload'] if ask else 'fresh')
    executor = Executor(Program())
    asyncio.run(executor.run({'ask': True}, 'c', 5))
    assert executor.pending('c') is not None
    assert asyncio.run(executor.run({'ask': False}, 'c', 5)) == {'answer': 'fresh'}
    assert executor.pending('c') is None


def test_a_large_run_without_a_pause_still_returns_its_output():
    async def transport(raw):
        message = json.loads(raw)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': 'x' * 400_000})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup@1', 'Look up', SCHEMA)
    class Program(dspy.Module):
        async def aforward(self):
            results = [await tool.acall(query=str(index)) for index in range(3)]
            return dspy.Prediction(answer=sum(map(len, results)))
    assert asyncio.run(Executor(Program()).run({}, 'c', 5)) == {'answer': 1_200_000}


def test_a_malformed_interaction_inside_a_tool_ends_the_run_unsupported():
    from galaxie.dspy import request_interaction
    def review(query: str) -> str:
        return request_interaction({**INTERACTION, 'component': 'not a component'})['payload']
    transport_for([LOOKUP, FINISH])
    module = dspy.ReAct(Question, tools=[dspy.Tool(review, name='lookup')], max_iters=2)
    module.set_lm(GalaxieLM('answer'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(module).run({'question': 'q'}, 'c', 5))
    assert error.value.code == 'unsupported'


def test_a_pause_beside_an_unfinished_write_reports_outcome_unknown():
    from galaxie.dspy import request_interaction
    release = asyncio.Event()
    async def transport(raw):
        message = json.loads(raw)
        await release.wait()
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': 'ok'})
    _bridge.install_transport(transport)
    tool = capability_tool('write@1', 'Write', SCHEMA)
    class Program(dspy.Module):
        async def aforward(self):
            async def ask():
                await asyncio.sleep(0)
                try:
                    return request_interaction(INTERACTION)
                finally:
                    release.set()
            await asyncio.gather(tool.acall(query='write'), ask())
            return dspy.Prediction(answer='done')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(Program()).run({}, 'c', 5))
    assert error.value.code == 'outcome_unknown'


def test_supported_predict_pause_resume_snapshot_bytes_stay_identical():
    from galaxie.dspy import request_interaction
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question -> answer')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            prediction = await self.predict.acall(question=question)
            answer = request_interaction(INTERACTION)
            return dspy.Prediction(answer=prediction.answer, action=answer['action'])

    seen = []
    transport_for([{'content': fields(answer='Paris')}], seen)
    executor = Executor(Program())
    assert asyncio.run(executor.run({'question': 'France?'}, 'conversation', 5)) is None
    assert executor._snapshot('conversation', 'session') == (b'{"conversation_id":"conversation","ordinal":1,"pauses":1,"input":{"question":"France?"},"journal":[{"kind":"model","digest":"0aaf48336f9b911a7b164c05b800c6b42aad36f6b2400c79c8790ae2a2ff698a","result":{"content":"[[ ## answer ## ]]\\nParis\\n[[ ## completed ## ]]"}},{"kind":"interaction","digest":"3f5624c30e141215bd65719f6e05a51f07c5e00e40bc14a039f7a63b922ea97c","request":{"surfaceId":"main","viewRevision":"review","component":"test.Review/v1","props":{}}}],"status":"paused"}', b'{"v":1,"dspy":"3.4.1","adapter":"ChatAdapter","session":"session"}')
    pending = executor.pending('conversation')
    assert pending is not None
    assert asyncio.run(executor.run(None, 'conversation', 5, resume={
        'interactionId': pending['id'], 'action': 'continue', 'payload': 'done',
    })) == {'answer': 'Paris', 'action': 'continue'}
    assert executor._snapshot('conversation', 'session') == (b'{"conversation_id":"conversation","ordinal":1,"pauses":1,"input":{"question":"France?"},"journal":[{"kind":"model","digest":"0aaf48336f9b911a7b164c05b800c6b42aad36f6b2400c79c8790ae2a2ff698a","result":{"content":"[[ ## answer ## ]]\\nParis\\n[[ ## completed ## ]]"}},{"kind":"interaction","digest":"3f5624c30e141215bd65719f6e05a51f07c5e00e40bc14a039f7a63b922ea97c","request":{"surfaceId":"main","viewRevision":"review","component":"test.Review/v1","props":{}},"result":{"action":"continue","payload":"done"}}],"status":"completed"}', b'{"v":1,"dspy":"3.4.1","adapter":"ChatAdapter","session":"session"}')
    assert len(seen) == 1
