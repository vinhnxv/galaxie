# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import pytest

from galaxie.lint import lint_source


@pytest.mark.parametrize("source", [
    "from google.adk.models.google_llm import Gemini",
    "import google.adk.models.google_llm",
    "from google.adk.models import google_llm",
    "from google.adk.models.registry import LLMRegistry",
    "from google.adk.models import registry",
    "from google.adk.models.lite_llm import LiteLlm",
    "from google.adk.models.anthropic_llm import Claude",
    "from google.adk.models.apigee_llm import ApigeeLlm",
    "from google.adk.models.gemma_llm import Gemma",
    "from google.adk.models import Gemini",
    "from google.adk.models import LLMRegistry as Registry",
    "from google.adk.models import LiteLlm, Claude",
    "from google.adk.integrations.openai import OpenAILlm",
    "from google.genai import Client",
])
def test_adk_direct_provider_access_is_rejected(source):
    with pytest.raises(ValueError, match="^The Python agent source uses unsupported direct access\\.$"):
        lint_source(source)


@pytest.mark.parametrize("source", [
    "from galaxie.adk import llm; llm('answer')",
    "from google.adk.agents import LlmAgent",
    "from google.adk.models.base_llm import BaseLlm",
    "from google.adk.models.llm_request import LlmRequest",
    "from google.adk.runners import InMemoryRunner",
])
def test_adk_routed_models_and_ordinary_imports_pass(source):
    lint_source(source)
