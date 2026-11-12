# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native ADK 2.12.0 evidence, using its Runner and scripted models only.

Gate | Observation
NM1 | Strings resolve lazily, cache by string, and reassignment takes effect.
NT1 | Toolset expansion is cached per invocation, not repeated per model request.
NN1 | Search contributes provider config, with no function call or local tool body.
NX1 | Built-in execution contributes config; unsafe local execution starts a child.
NL1 | Thinking contributes config; PlanReAct splits thoughts from the final answer.
"""

import asyncio

import pytest
from google.adk.agents import LlmAgent
from google.adk.code_executors import BuiltInCodeExecutor, UnsafeLocalCodeExecutor
from google.adk.models import registry
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.planners import BuiltInPlanner, PlanReActPlanner
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool, google_search
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types
from pydantic import Field

REQUESTS = []
CALLS = []


class Scripted(BaseLlm):
    replies: list = Field(default_factory=lambda: ['done'])

    @classmethod
    def supported_models(cls):
        return [r'^spike_answer(?:_two)?$']

    async def generate_content_async(self, llm_request, stream=False):
        REQUESTS.append(llm_request.model_copy(deep=True))
        reply = self.replies.pop(0)
        parts = [types.Part(text=reply)] if isinstance(reply, str) else [
            types.Part(function_call=types.FunctionCall(name=reply[0], args=reply[1]))]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


def double(value: int) -> dict:
    """Double an integer."""
    CALLS.append(value)
    return {'value': value * 2}


def square(value: int) -> dict:
    """Square an integer."""
    return {'value': value * value}


class StaticTools(BaseToolset):
    def __init__(self, tools, **options):
        super().__init__(**options)
        self.tools = tuple(tools)
        self.contexts = []
        self.closed = 0

    async def get_tools(self, readonly_context=None):
        self.contexts.append(readonly_context)
        return [tool for tool in self.tools if self._is_tool_selected(tool, readonly_context)]

    async def close(self):
        self.closed += 1


async def converse(root):
    REQUESTS.clear()
    CALLS.clear()
    runner = InMemoryRunner(agent=root, app_name='spike')
    await runner.session_service.create_session(app_name='spike', user_id='user', session_id='session')
    try:
        return [event async for event in runner.run_async(
            user_id='user', session_id='session',
            new_message=types.Content(role='user', parts=[types.Part(text='question')]))]
    finally:
        await runner.close()


def final_text(events):
    return ''.join(part.text or '' for event in events if event.is_final_response() and event.content
                   for part in event.content.parts or [] if not part.thought)


def test_strings_resolve_lazily_inherit_and_reassignment_invalidates_the_cache():
    saved = dict(registry._llm_registry_dict)
    try:
        registry.LLMRegistry.register(Scripted)
        child = LlmAgent(name='child')
        root = LlmAgent(name='root', model='spike_answer', sub_agents=[child])
        assert root._resolved_model is None
        first = root.canonical_model
        assert type(first) is Scripted
        assert root.canonical_model is first
        assert child.canonical_model is first
        assert final_text(asyncio.run(converse(root))) == 'done'
        root.model = 'spike_answer_two'
        assert root.canonical_model is not first
        replacement = Scripted(model='replacement')
        root.model = replacement
        assert root.canonical_model is replacement
        assert final_text(asyncio.run(converse(root))) == 'done'
        with pytest.raises(ValueError, match='not found'):
            asyncio.run(converse(LlmAgent(name='unknown', model='spike_unregistered')))
    finally:
        registry._llm_registry_dict.clear()
        registry._llm_registry_dict.update(saved)
        registry.LLMRegistry.resolve.cache_clear()
    assert registry._llm_registry_dict == saved


@pytest.mark.parametrize('filter_kind', ['none', 'list', 'callable'])
def test_toolset_expansion_is_cached_across_requests_and_close_runs(filter_kind):
    contexts = []

    def selected(tool, context):
        contexts.append(context)
        return tool.name == 'double'

    selection = {'none': None, 'list': ['double'], 'callable': selected}[filter_kind]
    tools = StaticTools([FunctionTool(double), FunctionTool(square)],
                        tool_filter=selection, tool_name_prefix='suite')
    model = Scripted(model='scripted', replies=[('suite_double', {'value': 21}), 'done'])
    assert final_text(asyncio.run(converse(LlmAgent(name='root', model=model, tools=[tools])))) == 'done'
    assert len(REQUESTS) == 2
    assert CALLS == [21]
    assert len(tools.contexts) == 1  # Prediction of per-request expansion did not hold.
    assert tools.closed == 1
    declarations = [tool.function_declarations for tool in REQUESTS[0].config.tools or []]
    names = [declaration.name for group in declarations if group for declaration in group]
    assert names == (['suite_double', 'suite_square'] if filter_kind == 'none' else ['suite_double'])
    if filter_kind == 'callable':
        assert len(contexts) == 2 and all(context is not None for context in contexts)


def test_search_only_adds_provider_config_and_rejects_a_non_gemini_name():
    root = LlmAgent(name='root', model=Scripted(model='gemini-2.5-flash'), tools=[google_search])
    assert final_text(asyncio.run(converse(root))) == 'done'
    assert len(REQUESTS) == 1 and CALLS == []
    assert REQUESTS[0].config.tools[0].google_search is not None
    assert REQUESTS[0].config.tools[0].function_declarations is None
    with pytest.raises(ValueError, match='not supported'):
        asyncio.run(converse(LlmAgent(name='root', model=Scripted(model='scripted'), tools=[google_search])))
    assert REQUESTS == []


@pytest.mark.parametrize('shape', ['code', 'thinking'])
def test_builtin_executor_and_planner_only_add_provider_configuration(shape):
    root = LlmAgent(
        name='root', model=Scripted(model='gemini-2.5-flash'),
        code_executor=BuiltInCodeExecutor() if shape == 'code' else None,
        planner=BuiltInPlanner(thinking_config=types.ThinkingConfig(thinking_budget=128)) if shape == 'thinking' else None,
    )
    assert final_text(asyncio.run(converse(root))) == 'done'
    assert len(REQUESTS) == 1 and CALLS == []
    if shape == 'code':
        assert REQUESTS[0].config.tools[0].code_execution is not None
    else:
        assert REQUESTS[0].config.thinking_config.thinking_budget == 128


def test_unsafe_local_code_can_read_an_author_file_and_feeds_the_result_back(tmp_path):
    sentinel = tmp_path / 'sentinel.txt'
    sentinel.write_text('author-sentinel')
    code = f'```python\nprint(open({str(sentinel)!r}).read())\n```'
    root = LlmAgent(name='root', model=Scripted(model='scripted', replies=[code, 'done']),
                    code_executor=UnsafeLocalCodeExecutor())
    assert final_text(asyncio.run(converse(root))) == 'done'
    assert len(REQUESTS) == 2
    # ADK converts execution results back to text before the next model request.
    feedback = [part.text or '' for content in REQUESTS[1].contents for part in content.parts or []]
    assert any('author-sentinel' in text and 'print(open' not in text for text in feedback)


def test_plan_react_retags_the_same_reply_and_changes_the_final_text():
    reply = '/*PLANNING*/think/*FINAL_ANSWER*/done'
    planned = asyncio.run(converse(LlmAgent(name='root', model=Scripted(model='scripted', replies=[reply]),
                                            planner=PlanReActPlanner())))
    assert '/*PLANNING*/' in str(REQUESTS[0].config.system_instruction)
    parts = [part for event in planned if event.content for part in event.content.parts or []]
    assert any(part.thought and part.text == 'think' for part in parts)
    assert final_text(planned) == 'done'
    plain = asyncio.run(converse(LlmAgent(name='root', model=Scripted(model='scripted', replies=[reply]))))
    assert final_text(plain) == reply
