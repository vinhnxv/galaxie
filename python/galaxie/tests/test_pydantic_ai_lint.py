# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from galaxie.lint import lint_source


@pytest.mark.parametrize("source", [
    "Agent('openai:gpt')",
    "from pydantic_ai.models.openai import OpenAIChatModel",
    "from pydantic_ai.models import openai",
    "import pydantic_ai.models.function",
    "from pydantic_ai.providers.openai import OpenAIProvider",
    "from pydantic_ai import providers",
    "infer_model(model_name)",
    "models.infer_model(model_name)",
])
def test_flags_direct_pydantic_ai_model_access(source):
    with pytest.raises(ValueError, match="^The Python agent source uses unsupported direct access\\.$"):
        lint_source(source)


@pytest.mark.parametrize("provider", [
    "google", "grok", "test", "function", "openai-chat", "openai-responses",
    "openai-decisions", "openai-codex", "openai-chatgpt", "azure-responses",
    "google-cloud", "bedrock-mantle", "vercel", "cerebras", "system-one",
    "crusoe", "elevenlabs", "xai", "moonshotai", "meta", "fireworks",
    "together", "heroku", "github", "github-copilot", "vllm", "nebius",
    "ovhcloud", "alibaba", "sambanova", "sentence-transformers", "snowflake",
    "typesafe", "voyageai", "zai", "gateway/openai",
])
def test_flags_pydantic_ai_provider_prefixes(provider):
    with pytest.raises(ValueError, match="^The Python agent source uses unsupported direct access\\.$"):
        lint_source(f"Agent('{provider}:fixture')")


def test_allows_galaxie_model_and_framework_types():
    lint_source("""
from pydantic_ai import Agent
from pydantic_ai.models import Model
from galaxie.pydantic_ai import GalaxieModel

agent = Agent(GalaxieModel('rag.answer'))
"""
    )
