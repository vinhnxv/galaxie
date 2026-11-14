# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native graph event records encounter the standing tree restore boundary."""

import asyncio
import base64
import json

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins import ToolCallIntegrityPlugin
from google.adk.runners import Runner
from google.adk.workflow import Workflow
from google.genai import types

from galaxie import GalaxieError
from galaxie.adk import APP_NAME, USER_ID, Executor, GalaxieSessionService, llm


class Scripted(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text='answer')]), turn_complete=True)


def test_native_completed_graph_record_is_refused_by_tree_restore_admission():
    async def measure():
        sessions = GalaxieSessionService()
        key = b'x' * 32
        root = Workflow(name='wf', edges=[('START', LlmAgent(name='a', model=Scripted(model='a')),
                                          LlmAgent(name='b', model=Scripted(model='b')))])
        runner = Runner(node=root, app_name=APP_NAME, session_service=sessions,
                        plugins=[ToolCallIntegrityPlugin(secret_key=key)])
        await sessions.create_session(app_name=APP_NAME, user_id=USER_ID, session_id='s')
        try:
            events = [event async for event in runner.run_async(user_id=USER_ID, session_id='s',
                      new_message=types.Content(role='user', parts=[types.Part(text='first')]))]
        finally:
            await runner.close()
        authored = [event for event in events if event.author in ('a', 'b')]
        assert [event.node_info.path for event in authored] == ['wf@1/a@1', 'wf@1/b@1']
        assert all(event.actions.agent_state is None and event.actions.end_of_agent is None for event in authored)
        assert authored[-1].node_info.output_for == ['wf@1/b@1', 'wf@1']
        assert authored[-1].node_info.message_as_output is True
        saved = sessions.sessions[APP_NAME][USER_ID]['s']
        checkpoint = json.dumps({'v': 1, 'conversation_id': 's', 'events': [
            json.loads(event.model_dump_json(by_alias=True, exclude_none=True)) for event in saved.events
        ]}).encode()
        metadata = json.dumps({'v': 1, 'key': base64.b64encode(key).decode(), 'pauses': 0, 'pending': None}).encode()
        fresh = Executor(LlmAgent(name='control', model=llm('control')))
        with pytest.raises(GalaxieError) as error:
            await fresh._restore(checkpoint, metadata)
        assert error.value.code == 'unrecoverable'
        assert fresh._sessions.sessions == {}

    asyncio.run(measure())
