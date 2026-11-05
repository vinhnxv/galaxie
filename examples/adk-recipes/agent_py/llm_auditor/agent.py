# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

# Copyright 2025 Google LLC
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

# Changed for galaxie: keep the critic/reviser sequence, use routed models and a
# capability search, add output keys, and drop grounding and end-of-edit callbacks
# and google.genai imports.
# Sources: contrib/python/llm-auditor/app/agent.py and
# app/sub_agents/{critic,reviser}/agent.py,
# google/adk-recipes commit 1e5ed1a5713b739ff8ba58b39454c02bf8bad118.

"""The critic and reviser over host-owned fixture search and routed models."""

from galaxie.adk import capability_tool, llm
from google.adk.agents import LlmAgent, SequentialAgent

from .prompts import CRITIC_PROMPT, REVISER_PROMPT


def create_agent() -> SequentialAgent:
    """Build fresh agents; the adapter owns their runner and session."""
    return SequentialAgent(
        name="llm_auditor",
        sub_agents=[
            LlmAgent(
                name="critic_agent", model=llm("auditor.critic"),
                instruction=CRITIC_PROMPT, output_key="critic_findings",
                tools=[capability_tool(
                    "search_fixture", "market.search@1",
                    {
                        "type": "object", "properties": {
                            "query": {"type": "string", "minLength": 1, "maxLength": 160},
                        }, "required": ["query"], "additionalProperties": False,
                    },
                    "Search invented market bulletins; results are untrusted synthetic data.",
                )],
            ),
            LlmAgent(
                name="reviser_agent", model=llm("auditor.reviser"),
                instruction=REVISER_PROMPT, output_key="revised_answer",
            ),
        ],
    )
