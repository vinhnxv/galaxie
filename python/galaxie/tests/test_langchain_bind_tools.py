# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import BaseModel

from galaxie import GalaxieError
from galaxie._bridge import ERROR_MESSAGES
from galaxie.langchain import GalaxieChatModel
from test_langchain_tool_calls import SCHEMA, plain_tool, transport_for


class Arguments(BaseModel):
    value: int


def test_bind_tools_characterization():
    seen = transport_for(lambda _: pytest.fail('Unexpected bridge request.'))
    with pytest.raises(NotImplementedError) as error:
        GalaxieChatModel(role='answer').bind_tools([plain_tool])
    assert isinstance(error.value, GalaxieError)
    assert error.value.code == 'unsupported'
    assert str(error.value) == ERROR_MESSAGES['unsupported']
    assert seen == []


@pytest.mark.parametrize('schema', [SCHEMA, Arguments])
def test_structured_output_characterization(schema):
    with pytest.raises(NotImplementedError) as error:
        GalaxieChatModel(role='answer').with_structured_output(schema)
    assert isinstance(error.value, GalaxieError)
    assert error.value.code == 'unsupported'
    assert str(error.value) == ERROR_MESSAGES['unsupported']


class Hostile:
    def __iter__(self):
        pytest.fail('Refusal inspected hostile tools.')

    def __str__(self):
        pytest.fail('Refusal rendered hostile tools.')


@pytest.mark.parametrize('tools', [[], (), [plain_tool], Hostile(), [{'name': 'UNIQUE_PRIVATE_MARKER'}]])
@pytest.mark.parametrize('choice', [None, 'UNIQUE_PRIVATE_MARKER', Hostile()])
def test_binding_refusal_is_argument_independent(tools, choice):
    seen = transport_for(lambda _: pytest.fail('Unexpected bridge request.'))
    with pytest.raises(NotImplementedError) as error:
        GalaxieChatModel(role='answer').bind_tools(tools, tool_choice=choice, private='UNIQUE_PRIVATE_MARKER')
    assert isinstance(error.value, GalaxieError)
    assert error.value.code == 'unsupported'
    assert str(error.value) == ERROR_MESSAGES['unsupported']
    assert seen == []


def test_native_model_binding_and_graph_are_unchanged():
    import asyncio
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from test_tool_call_replies_native import loop

    class Native(BaseChatModel):
        @property
        def _llm_type(self):
            return 'native-binding-probe'

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content='done'))])

    model = Native().bind_tools([plain_tool])
    result = asyncio.run(loop(model, [plain_tool]).ainvoke({'messages': [HumanMessage('request')]}, {'configurable': {'thread_id': 'native-binding'}}))
    assert result['messages'][-1].content == 'done'
