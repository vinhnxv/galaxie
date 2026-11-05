# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from galaxie.lint import lint_agent


def test_recipe_sources_pass_the_python_lint_aid() -> None:
    lint_agent(Path(__file__).resolve().parents[1])
