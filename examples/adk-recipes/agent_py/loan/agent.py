# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Changed for galaxie: replace the AgentTool coordinator with a SequentialAgent,
# use capability tools and routed models, and pause only in the final child.
# Drop App, cloud storage callbacks, process-status tools, judge, planner,
# Gemini configuration and google.genai imports; the host owns durable recovery.
# Sources: contrib/python/small-business-loan-agent/app/agent.py, app/prompt.py and
# app/sub_agents/{document_extraction,underwriting,pricing,loan_decision}/agent.py,
# google/adk-recipes commit 1e5ed1a5713b739ff8ba58b39454c02bf8bad118.

"""Four specialists ending in a confirmation-gated host capability."""

from typing import Any

from galaxie.adk import Executor, capability_tool, llm
from google.adk.agents import LlmAgent, SequentialAgent

from .prompts import (
    DOCUMENT_EXTRACTION_PROMPT,
    LOAN_DECISION_PROMPT,
    PRICING_PROMPT,
    UNDERWRITING_PROMPT,
)

APPLICATION_ID = {
    "type": "string", "maxLength": 52, "pattern": r"^application-[a-z0-9-]{1,40}$",
}
APPLICATION_PARAMETERS = {
    "type": "object", "properties": {"applicationId": APPLICATION_ID},
    "required": ["applicationId"], "additionalProperties": False,
}


def approval_interaction(requests: list[dict[str, Any]]) -> dict[str, Any]:
    """Project only the exact proposed write; the host adds its fixture summary."""
    if len(requests) != 1:
        raise ValueError("The loan confirmation is invalid.")
    request = requests[0]
    if request["kind"] != "confirmation" or request["tool"] != "finalize_loan_decision":
        raise ValueError("The loan confirmation is invalid.")
    args = request["args"]
    return {
        "surfaceId": "main", "viewRevision": "loan-1", "component": "recipes.LoanApproval/v1",
        "props": {"applicationId": args["applicationId"], "decision": args["decision"]},
    }


def create_agent() -> Executor:
    """The last child is the only pausing agent, so prior specialists never restart."""
    return Executor(
        SequentialAgent(name="small_business_loan", sub_agents=[
            LlmAgent(
                name="DocumentExtractionAgent", model=llm("loan.extraction"),
                instruction=DOCUMENT_EXTRACTION_PROMPT, output_key="DocumentExtractionAgent_output",
                tools=[capability_tool(
                    "get_application_documents", "loan.documents@1", APPLICATION_PARAMETERS,
                    "Read synthetic application documents.",
                )],
            ),
            LlmAgent(
                name="UnderwritingAgent", model=llm("loan.underwriting"),
                instruction=UNDERWRITING_PROMPT, output_key="UnderwritingAgent_output",
                tools=[capability_tool(
                    "get_internal_business_data", "loan.business@1", APPLICATION_PARAMETERS,
                    "Read synthetic internal business records.",
                )],
            ),
            LlmAgent(
                name="PricingAgent", model=llm("loan.pricing"),
                instruction=PRICING_PROMPT, output_key="PricingAgent_output",
                tools=[capability_tool(
                    "calculate_loan_pricing", "loan.price@1",
                    {
                        "type": "object",
                        "properties": {
                            "creditScore": {"type": "integer", "minimum": 300, "maximum": 850},
                            "amount": {"type": "integer", "minimum": 1000, "maximum": 250000},
                            "termMonths": {"type": "integer", "minimum": 12, "maximum": 60},
                        },
                        "required": ["creditScore", "amount", "termMonths"],
                        "additionalProperties": False,
                    },
                    "Return synthetic host pricing; never calculate a rate in Python.",
                )],
            ),
            LlmAgent(
                name="LoanDecisionAgent", model=llm("loan.decision"),
                instruction=LOAN_DECISION_PROMPT, output_key="LoanDecisionAgent_output",
                tools=[capability_tool(
                    "finalize_loan_decision", "loan.finalize@1",
                    {
                        "type": "object",
                        "properties": {
                            "applicationId": APPLICATION_ID,
                            "decision": {"type": "string", "enum": ["approved", "denied"]},
                        },
                        "required": ["applicationId", "decision"], "additionalProperties": False,
                    },
                    "Request human confirmation before recording the proposed synthetic decision.",
                    require_confirmation=True,
                )],
            ),
        ]),
        interaction=approval_interaction,
    )
