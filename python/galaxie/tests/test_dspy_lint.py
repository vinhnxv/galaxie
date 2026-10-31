# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from galaxie.lint import lint_source


@pytest.mark.parametrize("source", [
    "dspy.LM('openai/gpt-4o')",
    "dspy.LM(model='anthropic/fixture')",
    "from dspy import LM; LM('anthropic/fixture')",
    "from dspy import LM as Model; Model(model='openai/fixture')",
    "import dspy as ds; ds.LM('openai/fixture')",
    "dspy.Embedder('openai/text-embedding-3-small')",
    "from dspy import Embedder; Embedder(model='openai/fixture')",
    "import dspy.clients.openai",
    "from dspy.clients import databricks",
    "import dspy.clients.lm_local",
    "import dspy.lm15.providers",
    "from dspy.lm15.transports import Transport",
])
def test_dspy_direct_provider_access_is_rejected(source):
    with pytest.raises(ValueError, match="^The Python agent source uses unsupported direct access\\.$"):
        lint_source(source)


@pytest.mark.parametrize("source", [
    "from galaxie.dspy import GalaxieLM; GalaxieLM('rag.answer')",
    "from dspy import Predict; Predict('question -> answer')",
    "dspy.LM(model=custom_model)",
    "LM('ordinary application label')",
])
def test_dspy_routed_models_and_unrelated_calls_pass(source):
    lint_source(source)
