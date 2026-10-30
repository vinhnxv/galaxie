# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import importlib
import re
from typing import Any

from langchain_core.messages import BaseMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command, Interrupt

CASE_NAMES = (
    "linear", "branching", "subgraph", "model-without-config", "model-failure", "capability",
    "interrupt-resume", "interrupt-sequence", "interrupt-subgraph",
    "interrupt-durability-sync", "interrupt-durability-exit", "step-limit",
)
STAGE_A_CASES = (
    "interrupt-resume", "interrupt-sequence", "interrupt-durability-sync", "interrupt-durability-exit",
)
STREAM_MODES = ["values", "updates", "messages", "custom"]


def load_case(name):
    if name not in CASE_NAMES:
        raise ValueError("The conformance case is unknown.")
    return importlib.import_module(name.replace("-", "_"))


def project(value: Any) -> Any:
    if isinstance(value, Interrupt):
        return {"id": value.id, "value": project(value.value)}
    if isinstance(value, BaseMessage):
        return {"type": value.type, "content": project(value.content), "id": value.id}
    if isinstance(value, (list, tuple)):
        return [project(item) for item in value]
    if isinstance(value, dict):
        return {key: project(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError("The conformance value cannot be projected to JSON.")


def normalize(transcript):
    identifiers = {}
    interrupt_ids = {}
    for pause in transcript.get("pauses", []):
        for item in pause["interrupts"]:
            interrupt_ids.setdefault(item["id"], f"<interrupt:{len(interrupt_ids) + 1}>")

    def replace_uuid(match):
        key = match.group().lower()
        return identifiers.setdefault(key, f"<uuid:{len(identifiers) + 1}>")

    def visit(value):
        if isinstance(value, str):
            if value in interrupt_ids:
                return interrupt_ids[value]
            return re.sub(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                replace_uuid, value, flags=re.IGNORECASE,
            )
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, dict):
            return {visit(key): visit(item) for key, item in value.items()}
        return value

    return visit(project(transcript))


async def pending(graph, config):
    state = await graph.aget_state(config)
    interrupts = [interrupt for task in state.tasks for interrupt in task.interrupts]
    return [{"id": item.id, "value": project(item.value)} for item in interrupts]


async def record_case(name):
    case = load_case(name)
    graph = case.factory(InMemorySaver())
    config = {"configurable": {"thread_id": "python-conformance"}, "recursion_limit": 25}
    transcript = {
        "events": {mode: [] for mode in STREAM_MODES}, "modes": [], "final": None,
        "state": {"values": None, "next": []}, "checkpoints": [],
        "outcome": {"status": "succeeded"},
    }
    value = case.INPUT
    resume_index = 0
    try:
        while True:
            interrupted = False
            async for path, mode, data in graph.astream(
                value, config, stream_mode=STREAM_MODES, subgraphs=True,
            ):
                if mode == "messages":
                    message, metadata = data
                    data = [project(message), {
                        key: metadata[key] for key in ("langgraph_node", "langgraph_checkpoint_ns")
                        if key in metadata
                    }]
                transcript["events"][mode].append({"path": list(path), "data": project(data)})
                transcript["modes"].append(mode)
                if not path and mode == "values":
                    transcript["final"] = project(data)
                if not path and mode == "updates" and "__interrupt__" in data:
                    interrupted = True
            if not interrupted:
                break
            interrupts = await pending(graph, config)
            if len(interrupts) != 1 or not interrupts[0]["id"]:
                raise ValueError("Expected one checkpoint interrupt.")
            history = [item async for item in graph.aget_state_history(config)]
            transcript.setdefault("pauses", []).append({
                "interrupts": interrupts, "historyLength": len(history),
            })
            value = Command(resume={interrupts[0]["id"]: case.RESUMES[resume_index]})
            resume_index += 1
    except Exception as error:
        transcript["outcome"] = {"status": "failed", "errorType": type(error).__name__}
        transcript["final"] = None
    state = await graph.aget_state(config)
    transcript["state"] = {"values": project(state.values), "next": list(state.next)}
    async for checkpoint in graph.aget_state_history(config):
        parent = checkpoint.parent_config
        transcript["checkpoints"].append({
            "metadata": {"step": checkpoint.metadata.get("step"), "source": checkpoint.metadata.get("source")},
            "next": list(checkpoint.next), "values": project(checkpoint.values),
            "parentCheckpointId": parent["configurable"]["checkpoint_id"] if parent else None,
        })
    transcript["checkpoints"].reverse()
    return normalize(transcript)


async def record_reload(name):
    case = load_case(name)
    saver = InMemorySaver()
    graph = case.factory(saver)
    config = {"configurable": {"thread_id": "python-reconstruction"}}
    await graph.ainvoke(case.INPUT, config)
    original = await pending(graph, config)
    graph = case.factory(saver)
    rebuilt = await pending(graph, config)
    identifier = rebuilt[0]["id"]
    await graph.ainvoke(Command(resume={identifier: case.RESUMES[0]}), config)
    final = project((await graph.aget_state(config)).values)
    repeated_updates = []
    async for update in graph.astream(
        Command(resume={identifier: case.RESUMES[0]}), config, stream_mode="updates",
    ):
        repeated_updates.append(project(update))
    return {
        "samePending": rebuilt == original, "final": final,
        "repeatedFinal": project((await graph.aget_state(config)).values),
        "repeatedUpdates": repeated_updates,
    }
