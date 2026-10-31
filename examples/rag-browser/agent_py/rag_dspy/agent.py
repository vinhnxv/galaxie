# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any

import dspy

from galaxie import GalaxieError
from galaxie.capabilities import call
from galaxie.dspy import Executor, GalaxieLM, request_interaction
from rag_agent.citations import cite_answer
from rag_agent.prompt import system_prompt, user_prompt


class Answer(dspy.Signature):
    question: str = dspy.InputField()
    passages: str = dspy.InputField()
    answer: str = dspy.OutputField()


def kept_passages(submission: dict[str, Any], passages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = submission.get("payload")
    if (
        submission.get("action") != "submit"
        or type(payload) is not dict or set(payload) != {"keptIds"}
        or type(payload["keptIds"]) is not list
        or any(type(identifier) is not str for identifier in payload["keptIds"])
        or len(set(payload["keptIds"])) != len(payload["keptIds"])
        or not set(payload["keptIds"]) <= {passage["id"] for passage in passages}
    ):
        raise GalaxieError("invalid")
    return [passage for passage in passages if passage["id"] in payload["keptIds"]]


class Rag(dspy.Module):
    def __init__(self) -> None:
        super().__init__()
        self.answer = dspy.ChainOfThought(Answer.with_instructions(system_prompt))
        self.answer.set_lm(GalaxieLM("rag.answer"))

    async def aforward(self, question: str, mode: str, review: bool = False) -> dspy.Prediction:
        result = await call("docs.search@1", {"query": question, "mode": mode, "k": 10})
        passages = result["passages"]
        if review:
            submission = request_interaction({
                "surfaceId": "rag-review", "component": "rag.ReviewPassages/v1", "viewRevision": "review-v1",
                "props": {"passages": [{"id": p["id"], "title": p["title"]} for p in passages]},
            })
            passages = kept_passages(submission, passages)
        reply = await self.answer.acall(question=question, passages=user_prompt(question, passages))
        return dspy.Prediction(**cite_answer(reply.answer, passages))


def create_agent() -> Executor:
    return Executor(Rag(), stream_fields=["answer"])
