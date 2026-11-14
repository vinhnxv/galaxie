# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native parent-plugin ownership and explicit abort-signal propagation."""

import asyncio
from collections import Counter

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.runners import InMemoryRunner
from google.adk.tools import AgentTool
from google.genai import types


async def observe(abort=False):
    calls = []
    plugin_calls = []
    turns = Counter()
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    signal = asyncio.Event()
    closed = []

    class Witness(BasePlugin):
        async def before_model_callback(self, *, callback_context, llm_request):
            plugin_calls.append(callback_context.agent_name)

        async def close(self):
            closed.append(self.name)

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            calls.append(self.model)
            turns[self.model] += 1
            if self.model == 'inner' and abort:
                entered.set()
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            parts = [types.Part(function_call=types.FunctionCall(name='inner', args={'request': 'go'}))] if (
                self.model == 'outer' and turns['outer'] == 1
            ) else [types.Part(text=f'{self.model} answer')]
            yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)

    inner = LlmAgent(name='inner', model=Scripted(model='inner'))
    outer = LlmAgent(name='outer', model=Scripted(model='outer'), tools=[AgentTool(inner)])
    runner = InMemoryRunner(agent=outer, app_name='native_lifecycle', plugins=[Witness(name='witness')])
    await runner.session_service.create_session(app_name='native_lifecycle', user_id='user', session_id='s')

    async def collect():
        return [event async for event in runner.run_async(user_id='user', session_id='s',
                new_message=types.Content(role='user', parts=[types.Part(text='start')] ), abort_signal=signal)]

    try:
        task = asyncio.create_task(collect())
        if abort:
            await asyncio.wait_for(entered.wait(), 5)
            signal.set()
        events = await asyncio.wait_for(task, 5)
        assert closed == []
    finally:
        await runner.close()
    return calls, plugin_calls, cancelled.is_set(), closed, events


def test_native_inner_runner_inherits_parent_plugin_without_closing_it():
    calls, plugins, cancelled, closed, _ = asyncio.run(observe())
    assert calls == plugins == ['outer', 'inner', 'outer']
    assert cancelled is False
    assert closed == ['witness']


def test_native_explicit_parent_abort_signal_cancels_the_inner_model():
    calls, plugins, cancelled, closed, events = asyncio.run(observe(abort=True))
    assert calls == plugins == ['outer', 'inner']
    assert cancelled is True
    assert closed == ['witness']
    assert not any(event.author == 'inner' for event in events)
