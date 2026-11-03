# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Offline Google ADK gate with scripted models, also evaluated unchanged inside Pyodide."""

import asyncio
import hashlib
import json
import threading

from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.agents._streaming_mode import StreamingMode
from google.adk.agents.run_config import RunConfig
from google.adk.apps import App
from google.adk.events import Event
from google.adk.models import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins import ToolCallIntegrityPlugin
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool, LongRunningFunctionTool, exit_loop
from google.genai import types
from pydantic import BaseModel, PrivateAttr

APP = "gate"
USER = "learner"


def text(value, partial=False):
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=value)]), partial=partial)


def call(name, args, identifier=None):
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[types.Part(function_call=types.FunctionCall(name=name, args=args, id=identifier))],
        )
    )


class ScriptedLlm(BaseLlm):
    """A model that replays scripted turns and records the request it receives."""

    model: str = "galaxie/scripted"
    _turns: list = PrivateAttr(default_factory=list)
    _requests: list = PrivateAttr(default_factory=list)

    @classmethod
    def scripted(cls, *turns):
        llm = cls()
        llm._turns = list(turns)
        return llm

    @property
    def requests(self):
        return self._requests

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(
            hashlib.sha256(
                json.dumps(
                    [content.model_dump(mode="json", exclude_none=True) for content in llm_request.contents],
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
        )
        turn = self._turns.pop(0)
        if isinstance(turn, BaseException):
            raise turn
        for response in turn if isinstance(turn, list) else [turn]:
            yield response


class GateFailure(Exception):
    pass


class Verdict(BaseModel):
    answer: str


def lookup(query: str) -> dict:
    """Look up the gate answer."""
    return {"answer": "Paris", "query": query}


def explode(query: str) -> dict:
    """Raise a tool failure."""
    raise GateFailure("tool failed")


def message(value):
    return types.Content(role="user", parts=[types.Part(text=value)])


async def start(agent, plugins=None, service=None, session="s1"):
    service = service or InMemorySessionService()
    await service.create_session(app_name=APP, user_id=USER, session_id=session)
    runner = Runner(app=App(name=APP, root_agent=agent, plugins=plugins or []), session_service=service)
    return runner, service


async def drive(runner, content, session="s1", config=None):
    events = []
    async for event in runner.run_async(user_id=USER, session_id=session, new_message=content, run_config=config):
        events.append(event)
    return events


def parts(events):
    return [part for event in events if event.content for part in event.content.parts or []]


def texts(events):
    return [part.text for part in parts(events) if part.text and not part.thought]


def calls(events, name=None):
    return [part.function_call for part in parts(events) if part.function_call and (name is None or part.function_call.name == name)]


async def gate_text_and_tool():
    llm = ScriptedLlm.scripted(text("Paris"))
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer."))
    assert texts(await drive(runner, message("capital?"))) == ["Paris"]
    llm = ScriptedLlm.scripted(call("lookup", {"query": "France"}), text("Paris"))
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer.", tools=[FunctionTool(lookup)]))
    events = await drive(runner, message("capital?"))
    assert [item.args for item in calls(events, "lookup")] == [{"query": "France"}]
    assert texts(events)[-1] == "Paris"
    assert len(llm.requests) == 2


async def gate_confirmation():
    llm = ScriptedLlm.scripted(call("lookup", {"query": "France"}), text("Paris"))
    agent = LlmAgent(name="root", model=llm, instruction="Answer.", tools=[FunctionTool(lookup, require_confirmation=True)])
    runner, _ = await start(agent)
    first = await drive(runner, message("capital?"))
    pending = calls(first, "adk_request_confirmation")
    assert len(pending) == 1 and pending[0].id
    answer = types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    id=pending[0].id, name="adk_request_confirmation", response={"confirmed": True}
                )
            )
        ],
    )
    second = await drive(runner, answer)
    assert texts(second)[-1] == "Paris"
    assert any(item.name == "lookup" for item in calls(second)) or any(
        part.function_response and part.function_response.name == "lookup" for part in parts(second)
    )


async def gate_long_running():
    def approve(query: str) -> dict:
        """Wait for a human answer."""
        return {"status": "pending", "ticket": query}

    llm = ScriptedLlm.scripted(call("approve", {"query": "T-1"}), text("Waiting"), text("Done"))
    agent = LlmAgent(name="root", model=llm, instruction="Answer.", tools=[LongRunningFunctionTool(approve)])
    runner, _ = await start(agent)
    first = await drive(runner, message("go"))
    long_running = [event for event in first if event.long_running_tool_ids]
    assert long_running and calls(first, "approve")
    identifier = calls(first, "approve")[0].id
    answer = types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(id=identifier, name="approve", response={"status": "approved"})
            )
        ],
    )
    assert texts(await drive(runner, answer))[-1] == "Done"


async def gate_streaming():
    llm = ScriptedLlm.scripted([text("Par", partial=True), text("is", partial=True), text("Paris")])
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer."))
    events = await drive(runner, message("capital?"), config=RunConfig(streaming_mode=StreamingMode.SSE))
    assert [bool(event.partial) for event in events if texts([event])] == [True, True, False]
    assert texts([event for event in events if not event.partial]) == ["Paris"]


async def gate_workflows():
    sequence = SequentialAgent(
        name="sequence",
        sub_agents=[
            LlmAgent(name="first", model=ScriptedLlm.scripted(text("one")), instruction="One."),
            LlmAgent(name="second", model=ScriptedLlm.scripted(text("two")), instruction="Two."),
        ],
    )
    runner, _ = await start(sequence)
    assert texts(await drive(runner, message("go"))) == ["one", "two"]
    parallel = ParallelAgent(
        name="parallel",
        sub_agents=[
            LlmAgent(name="left", model=ScriptedLlm.scripted(text("l")), instruction="L."),
            LlmAgent(name="right", model=ScriptedLlm.scripted(text("r")), instruction="R."),
        ],
    )
    runner, _ = await start(parallel)
    assert sorted(texts(await drive(runner, message("go")))) == ["l", "r"]
    loop = LoopAgent(
        name="loop",
        max_iterations=3,
        sub_agents=[
            LlmAgent(
                name="worker",
                model=ScriptedLlm.scripted(call("exit_loop", {}), text("stopped")),
                instruction="Stop.",
                tools=[exit_loop],
            )
        ],
    )
    runner, _ = await start(loop)
    events = await drive(runner, message("go"))
    assert texts(events) == []
    assert any(event.actions.escalate for event in events)


async def gate_structured_and_transfer():
    llm = ScriptedLlm.scripted(text('{"answer": "Paris"}'))
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer.", output_schema=Verdict))
    assert json.loads(texts(await drive(runner, message("capital?")))[-1]) == {"answer": "Paris"}
    child = LlmAgent(name="child", model=ScriptedLlm.scripted(text("from child")), instruction="Child.", description="The child.")
    root = LlmAgent(
        name="root",
        model=ScriptedLlm.scripted(call("transfer_to_agent", {"agent_name": "child"})),
        instruction="Delegate.",
        sub_agents=[child],
    )
    runner, _ = await start(root)
    events = await drive(runner, message("go"))
    assert texts(events)[-1] == "from child"
    assert [event.actions.transfer_to_agent for event in events if event.actions.transfer_to_agent] == ["child"]


async def gate_failures():
    llm = ScriptedLlm.scripted(call("explode", {"query": "x"}))
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer.", tools=[FunctionTool(explode)]))
    try:
        await drive(runner, message("go"))
    except GateFailure:
        pass
    else:
        raise AssertionError("A raising tool must reach the caller.")
    llm = ScriptedLlm.scripted(GateFailure("model failed"))
    runner, _ = await start(LlmAgent(name="root", model=llm, instruction="Answer."))
    try:
        await drive(runner, message("go"))
    except GateFailure:
        pass
    else:
        raise AssertionError("A raising model must reach the caller.")


async def gate_cancellation():
    started = asyncio.Event()

    class Slow(ScriptedLlm):
        async def generate_content_async(self, llm_request, stream=False):
            started.set()
            await asyncio.sleep(60)
            yield text("late")

    runner, _ = await start(LlmAgent(name="root", model=Slow(), instruction="Answer."))
    task = asyncio.ensure_future(drive(runner, message("go")))
    await started.wait()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        return
    raise AssertionError("The cancelled run must raise CancelledError.")


async def restored_service(service, session, tamper=None):
    """Replays stored events into a fresh service, optionally changing them on the way."""
    saved = await service.get_session(app_name=APP, user_id=USER, session_id=session)
    records = [event.model_dump_json(by_alias=True, exclude_none=True) for event in saved.events]
    fresh = InMemorySessionService()
    restored = await fresh.create_session(app_name=APP, user_id=USER, session_id=session)
    for record in records:
        event = Event.model_validate_json(record)
        if tamper is not None:
            tamper(event)
        await fresh.append_event(restored, event)
    return fresh


async def gate_restore():
    llm = ScriptedLlm.scripted(call("lookup", {"query": "France"}), text("Paris"))
    agent = LlmAgent(name="root", model=llm, instruction="Answer.", tools=[FunctionTool(lookup)])
    runner, service = await start(agent)
    await drive(runner, message("capital?"))
    fresh = await restored_service(service, "s1")
    again = ScriptedLlm.scripted(text("Still Paris"))
    runner = Runner(
        app=App(name=APP, root_agent=LlmAgent(name="root", model=again, instruction="Answer.", tools=[FunctionTool(lookup)])),
        session_service=fresh,
    )
    assert texts(await drive(runner, message("again?")))[-1] == "Still Paris"
    assert len(again.requests) == 1


async def gate_integrity():
    key = b"gate-key-gate-key-gate-key-gate!"
    llm = ScriptedLlm.scripted(call("lookup", {"query": "France"}), text("Paris"))
    agent = LlmAgent(name="root", model=llm, instruction="Answer.", tools=[FunctionTool(lookup)])
    runner, service = await start(agent, plugins=[ToolCallIntegrityPlugin(secret_key=key)])
    await drive(runner, message("capital?"))

    def resumed(fresh, replies):
        return Runner(
            app=App(
                name=APP,
                root_agent=LlmAgent(name="root", model=replies, instruction="Answer.", tools=[FunctionTool(lookup)]),
                plugins=[ToolCallIntegrityPlugin(secret_key=key)],
            ),
            session_service=fresh,
        )

    again = ScriptedLlm.scripted(text("Verified"))
    fresh = await restored_service(service, "s1")
    assert texts(await drive(resumed(fresh, again), message("again?")))[-1] == "Verified"

    def tamper(event):
        for fc in event.get_function_calls():
            fc.args = {"query": "Germany"}

    never = ScriptedLlm.scripted(text("never"))
    fresh = await restored_service(service, "s1", tamper)
    try:
        await drive(resumed(fresh, never), message("again?"))
    except RuntimeError as error:
        assert type(error.__cause__).__name__ == "ToolCallIntegrityError"
        assert never.requests == []
    else:
        raise AssertionError("A tampered stored call must fail the integrity check.")


async def run_gate():
    spawned = []
    original = threading.Thread.start

    def spy(self, *args, **kwargs):
        spawned.append(self.name)
        return original(self, *args, **kwargs)

    threading.Thread.start = spy
    try:
        await gate_text_and_tool()
        await gate_confirmation()
        await gate_long_running()
        await gate_streaming()
        await gate_workflows()
        await gate_structured_and_transfer()
        await gate_failures()
        await gate_cancellation()
        await gate_restore()
        await gate_integrity()
    finally:
        threading.Thread.start = original
    import google.adk

    return {"version": google.adk.__version__, "threads": spawned}


def test_adk_offline_scripted_gate():
    result = asyncio.run(run_gate())
    assert result["version"] == "2.12.0"
    assert result["threads"] == []
