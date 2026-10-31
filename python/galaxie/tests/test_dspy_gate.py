# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Offline DSPy custom-engine gate, also evaluated unchanged inside Pyodide."""

import asyncio
import hashlib
import json

import anyio
import dspy
from dspy.clients.lm15_boundary import request_kwargs
from dspy.lm15 import Message, Response, TextPart, Usage


def fields(**values):
    return "\n".join(f"[[ ## {name} ## ]]\n{value}" for name, value in values.items()) + "\n[[ ## completed ## ]]"


class GateEngine:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    async def complete(self, request):
        payload = request_kwargs(request, "chat")
        self.requests.append(hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        return Response(id="gate", model=request.model, message=Message(role="assistant", parts=(TextPart(next(self.replies)),)), finish_reason="stop", usage=Usage(input_tokens=2, output_tokens=2, total_tokens=4))

    async def aclose(self):
        pass


class SyncGateEngine:
    def complete(self, request):
        raise AssertionError("The gate must use the asynchronous engine.")


class GateLM(dspy.LM):
    def __init__(self, engine):
        super().__init__("galaxie/gate", engine=SyncGateEngine(), async_engine=engine, cache=False, num_retries=0, temperature=None, max_tokens=None)

    @property
    def supports_function_calling(self):
        return False

    @property
    def supports_response_schema(self):
        return False

    @property
    def supported_params(self):
        return {"stop"}


class GateTermination(BaseException):
    pass


class GateQuestion(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


async def gate_program(kind, terminate=False):
    tools = []

    async def lookup(query: str) -> str:
        """Look up the gate answer."""
        tools.append(query)
        if terminate:
            raise GateTermination()
        return "Paris"

    if kind == "predict":
        module = dspy.Predict("question -> answer")
        replies = [fields(answer="Paris")]
    elif kind == "chain-of-thought":
        module = dspy.ChainOfThought("question -> answer")
        replies = [fields(reasoning="Use the supplied fact.", answer="Paris")]
    elif kind == "react":
        module = dspy.ReAct(GateQuestion, tools=[lookup], max_iters=1)
        replies = [fields(next_thought="Look up the fact.", next_tool_name="lookup", next_tool_args='{"query":"France"}'), fields(reasoning="Use the observation.", answer="Paris")]
    elif kind == "react-v2":
        module = dspy.ReActV2(GateQuestion, tools=[lookup], max_iters=2)
        replies = [fields(next_thought="Look up the fact.", tool_calls='[{"name":"lookup","args":{"query":"France"}}]'), fields(next_thought="Submit the answer.", tool_calls='[{"name":"submit","args":{"answer":"Paris"}}]')]
    else:
        raise AssertionError("Unknown gate program.")
    engine = GateEngine(replies)
    with dspy.context(lm=GateLM(engine), adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
        try:
            result = await module.acall(question="What is the capital of France?")
        except GateTermination:
            assert terminate and len(engine.requests) == 1
            return engine.requests
    assert not terminate
    assert result.answer == "Paris"
    assert tools == (["France"] if kind.startswith("react") else [])
    return engine.requests


async def gate_anyio():
    send, receive = anyio.create_memory_object_stream(1)
    async with anyio.create_task_group() as group:
        group.start_soon(send.send, "ready")
        assert await receive.receive() == "ready"
        with anyio.CancelScope(shield=True):
            await anyio.sleep(0)
        group.cancel_scope.cancel()
    cancelled = False
    with anyio.CancelScope() as scope:
        scope.cancel()
        try:
            await anyio.sleep(0)
        except anyio.get_cancelled_exc_class():
            cancelled = True
    assert cancelled
    await send.aclose()
    await receive.aclose()


async def run_gate():
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    digests = {}
    for kind in ["predict", "chain-of-thought", "react", "react-v2"]:
        first = await gate_program(kind)
        assert first == await gate_program(kind)
        digests[kind] = first
    for kind in ["react", "react-v2"]:
        await gate_program(kind, terminate=True)
    engine = GateEngine(["malformed reply"])
    with dspy.context(lm=GateLM(engine), adapter=dspy.ChatAdapter(use_json_adapter_fallback=False), disable_history=True, trace=None, callbacks=[]):
        try:
            await dspy.Predict("question -> answer").acall(question="gate")
        except dspy.AdapterParseError:
            pass
        else:
            raise AssertionError("A malformed reply must fail parsing.")
    assert len(engine.requests) == 1
    await gate_anyio()
    return {"version": dspy.__version__, "digests": digests, "anyio": True, "termination": True, "parseWithoutFallback": True}


def test_dspy_offline_custom_engine_gate():
    assert asyncio.run(run_gate())["version"] == "3.4.1"
