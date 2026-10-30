# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from pathlib import Path

import pytest

from galaxie.lint import lint_agent, lint_source


@pytest.mark.parametrize("source", [
    "import js",
    "from js import fetch",
    "import pyodide_js",
    "from pyodide.ffi import create_proxy",
    "from pyodide import ffi",
    "import urllib.request",
    "from http.client import HTTPConnection",
    "from http import client",
    "import socket",
    "import openai",
    "__import__('js')",
    "importlib.import_module('pyodide.http')",
    "Agent('openai:fixture')",
])
def test_flags_direct_access(source):
    with pytest.raises(ValueError, match="^The Python agent source uses unsupported direct access\\.$"):
        lint_source(source)


def test_real_agent_sources_pass():
    lint_agent(Path(__file__).resolve().parents[1])
