# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""M-py: ALTERNATIVE. GM1 fails without a prepare-time declared-role list.

NM1 passes in the native evidence file. GM2-GM8 are not measured: outcome fixed
by GM1. AL-M passes with an explicit routed model under the same one-reply script.
Name-predicate observation is independent: galaxie/gemini-* is Gemini-like to ADK.
"""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.utils.model_name_utils import extract_model_name, is_gemini_model
from google.genai import types

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, llm


class Scripted(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text='done')]))


def install(seen):
    async def transport(raw):
        message = json.loads(raw)
        seen.append((message['op'], message['payload']))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'done'}})
    _bridge.install_transport(transport)


@pytest.mark.parametrize('value', [
    'answer', 'undeclared', 'gemini-2.5-flash', 'Answer', ' answer', 'answer ', '',
    'galaxie:answer', 'galaxie/answer', Gemini(model='gemini-2.5-flash'), Scripted(model='foreign'),
])
def test_unmapped_strings_and_foreign_models_refuse_before_bridge_requests(value):
    seen = []
    install(seen)
    with pytest.raises(GalaxieError) as error:
        Executor(LlmAgent(name='root', model=value))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_a_test_local_string_replacement_cannot_validate_undeclared_roles_at_prepare():
    seen = []
    install(seen)
    root = LlmAgent(name='root', model='undeclared')
    # The smallest pre-pass has no role inventory to consult. Do not ship it.
    assert isinstance(root.model, str)
    root.model = llm(root.model)
    assert Executor(root)
    assert seen == []


def test_explicit_role_helper_matches_the_native_one_reply_script():
    async def native():
        runner = InMemoryRunner(agent=LlmAgent(name='root', model=Scripted(model='scripted')),
                                app_name='spike')
        await runner.session_service.create_session(app_name='spike', user_id='user', session_id='s')
        try:
            return ''.join([part.text or '' async for event in runner.run_async(
                user_id='user', session_id='s',
                new_message=types.Content(role='user', parts=[types.Part(text='question')]))
                if event.is_final_response() and event.content for part in event.content.parts or []])
        finally:
            await runner.close()

    seen = []
    install(seen)
    result = asyncio.run(Executor(LlmAgent(name='root', model=llm('answer'))).run(
        {'prompt': 'question'}, 's', 5))
    assert result == asyncio.run(native()) == 'done'
    assert [op for op, _ in seen] == ['model']
    assert seen[0][1]['role'] == 'answer'
    assert seen[0][1]['options'] == {}


def test_a_gemini_named_role_satisfies_the_native_name_predicate():
    model = llm('gemini-2.5-flash')
    assert model.model == 'galaxie/gemini-2.5-flash'
    assert extract_model_name(model.model) == 'gemini-2.5-flash'
    assert is_gemini_model(model.model)
