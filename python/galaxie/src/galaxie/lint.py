# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""A syntax-only aid for trusted Python agents; it is not runtime enforcement."""

import ast
import re
from pathlib import Path

_MESSAGE = "The Python agent source uses unsupported direct access."
_MODULES = (
    "js", "pyodide_js", "pyodide.http", "pyodide.ffi", "pyodide.code", "urllib",
    "http.client", "socket", "openai", "anthropic", "cohere", "groq", "mistralai",
    "google.genai", "google.generativeai", "ollama", "litellm", "langchain_openai",
    "langchain_anthropic", "langchain_google_genai", "langchain_ollama",
)
_PROVIDER = re.compile(
    r"^(?:openai|anthropic|cohere|groq|mistral|mistralai|google-gla|google-vertex|"
    r"ollama|litellm|azure|bedrock|huggingface|deepseek|openrouter):", re.IGNORECASE
)


def _forbidden(name: str) -> bool:
    return any(name == module or name.startswith(module + ".") for module in _MODULES)


def lint_source(source: str) -> None:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        raise ValueError(_MESSAGE) from None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(_forbidden(alias.name) for alias in node.names):
            raise ValueError(_MESSAGE)
        if isinstance(node, ast.ImportFrom) and node.module:
            if _forbidden(node.module) or any(_forbidden(node.module + "." + alias.name) for alias in node.names):
                raise ValueError(_MESSAGE)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and _PROVIDER.match(node.value):
            raise ValueError(_MESSAGE)
        if isinstance(node, ast.Call):
            dynamic = (
                isinstance(node.func, ast.Name) and node.func.id == "__import__"
            ) or (
                isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "importlib"
            )
            if dynamic and node.args and isinstance(node.args[0], ast.Constant):
                name = node.args[0].value
                if isinstance(name, str) and _forbidden(name):
                    raise ValueError(_MESSAGE)


def lint_agent(directory: Path) -> None:
    for source in sorted(directory.rglob("*.py")):
        lint_source(source.read_text(encoding="utf-8"))


if __name__ == "__main__":
    import sys

    try:
        if len(sys.argv) != 2:
            raise ValueError(_MESSAGE)
        lint_agent(Path(sys.argv[1]))
    except (OSError, ValueError):
        print(_MESSAGE, file=sys.stderr)
        raise SystemExit(1) from None
