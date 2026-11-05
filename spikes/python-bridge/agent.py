# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Real framework execution; synthetic prompts and read-only host fixtures only."""

import asyncio
import importlib.metadata
import json
import os
from typing import TypedDict

os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model


class GalaxieError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


async def rpc(op, payload):
    raw = await bridge_json(json.dumps({"op": op, "payload": payload}))
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("The bridge reply is invalid.")
    if value.get("ok") is True and isinstance(value.get("value"), dict):
        return value["value"]
    if value.get("ok") is False and value.get("error", {}).get("code") == "cancelled":
        raise GalaxieError("cancelled", "The run was cancelled.")
    raise GalaxieError("invalid", "The bridge reply is invalid.")


class GalaxieChatModel(BaseChatModel):
    @property
    def _llm_type(self):
        return "galaxie-bridge"

    def _generate(self, *args, **kwargs):
        raise NotImplementedError("Use the asynchronous bridge.")

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        reply = await rpc("model", {"role": "spike", "messages": [
            {"role": "user", "content": m.content} for m in messages
        ]})
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=reply["content"]))])


class State(TypedDict, total=False):
    text: str
    doubled: int
    action: str


model = GalaxieChatModel()
entries = {"model": 0, "capability": 0, "interaction": 0}
scopes = []


async def model_node(state, config):
    entries["model"] += 1
    reply = await model.ainvoke([HumanMessage(content="abort" if state.get("text") == "abort" else "langgraph")], config=config)
    return {"text": reply.content}


async def capability_node(state, config):
    entries["capability"] += 1
    scope = config["metadata"]["langgraph_checkpoint_ns"]
    scopes.append(scope)
    result = await rpc("capability", {"name": "math.double@1", "input": {"value": 21}, "effectScope": scope})
    return {"doubled": result["value"]}


def request_interaction(request, config):
    if set(request) != {"surfaceId", "viewRevision", "component", "props"}:
        raise GalaxieError("invalid", "The interaction request is invalid.")
    if not config.get("configurable", {}).get("thread_id"):
        raise GalaxieError("invalid", "The interaction config is invalid.")
    return interrupt(request)


def interaction_node(state, config):
    entries["interaction"] += 1
    request = {"surfaceId": "main", "viewRevision": "spike-1", "component": "education.Quiz/v1", "props": {"question": "Continue?"}}
    submission = request_interaction(request, config)
    return {"action": submission["action"]}


builder = StateGraph(State)
builder.add_node("model", model_node)
builder.add_node("capability", capability_node)
builder.add_node("interaction", interaction_node)
builder.add_edge(START, "model")
builder.add_edge("model", "capability")
builder.add_edge("capability", "interaction")
builder.add_edge("interaction", END)
graph = builder.compile(checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "spike"}}


class GalaxieModel(Model):
    @property
    def model_name(self):
        return "galaxie-mock"

    @property
    def system(self):
        return "galaxie"

    async def request(self, messages, model_settings, model_request_parameters):
        parts = [part for message in messages for part in message.parts]
        returned = next((p for p in parts if isinstance(p, ToolReturnPart)), None)
        # Two fixed prompts select the deterministic mock's tool and final replies.
        prompt = "pydantic:first" if returned is None else f"pydantic:tool:{returned.content['value']}"
        reply = await rpc("model", {"role": "spike", "messages": [{"role": "user", "content": prompt}]})
        if "tool" in reply:
            return ModelResponse(parts=[ToolCallPart(reply["tool"]["name"], reply["tool"]["arguments"], tool_call_id="double-1")])
        return ModelResponse(parts=[TextPart(reply["content"])])


agent = Agent(GalaxieModel())
agent.instrument = False


@agent.tool_plain
async def double(value: int) -> dict:
    """Double a synthetic integer through the host capability."""
    return await rpc("capability", {"name": "math.double@1", "input": {"value": value}, "effectScope": "pydantic-run"})


def versions_json():
    return json.dumps({d.metadata["Name"]: d.version for d in importlib.metadata.distributions()})


async def execute_json(raw):
    command = json.loads(raw)
    op = command["op"]
    if op == "graph":
        await graph.ainvoke({}, config)
        snapshot = await graph.aget_state(config)
        assert len(snapshot.interrupts) == 1
        pending = snapshot.interrupts[0]
        assert set(pending.value) == {"surfaceId", "viewRevision", "component", "props"}
        return json.dumps({"interactionId": pending.id, "request": pending.value, "entries": entries, "scopes": scopes})
    if op == "resume":
        result = await graph.ainvoke(Command(resume={command["interactionId"]: {"action": "submit", "payload": {"answer": True}}}), config)
        snapshot = await graph.aget_state(config)
        assert not snapshot.interrupts
        assert result == {"text": "mock graph reply", "doubled": 42, "action": "submit"}
        assert entries == {"model": 1, "capability": 1, "interaction": 2}
        return json.dumps({"state": result, "entries": entries})
    if op == "agent":
        result = await agent.run("Double 21 using the tool.")
        assert result.output == "mock agent reply: 42"
        return json.dumps({"output": result.output, "requests": result.usage.requests})
    if op == "abortProbe":
        task = asyncio.create_task(graph.ainvoke({"text": "abort"}, {"configurable": {"thread_id": "abort"}}))
        try:
            await task
        except GalaxieError as error:
            assert error.code == "cancelled"
            return json.dumps({"cancelled": True, "code": error.code})
        raise AssertionError("The aborted model call completed.")
    raise ValueError("The worker command is invalid.")
