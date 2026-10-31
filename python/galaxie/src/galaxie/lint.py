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
    "pydantic_ai.providers",
    "dspy.clients.openai", "dspy.clients.databricks", "dspy.clients.lm_local",
    "dspy.lm15.providers", "dspy.lm15.transports",
    *("pydantic_ai.models." + module for module in (
        "anthropic", "bedrock", "bedrock_mantle", "cerebras", "cohere", "crusoe",
        "function", "github_copilot", "google", "groq", "huggingface", "mcp_sampling",
        "mistral", "ollama", "openai", "openai_codex", "openai_decisions", "openrouter",
        "snowflake", "system_one", "test", "typesafe", "xai", "zai",
    )),
)
_PROVIDER = re.compile(
    r"^(?:gateway/)?(?:openai|openai-chat|openai-responses|openai-decisions|openai-codex|"
    r"openai-chatgpt|anthropic|cohere|groq|grok|mistral|mistralai|google|google-cloud|"
    r"google-gla|google-vertex|ollama|litellm|azure|azure-responses|bedrock|bedrock-mantle|"
    r"huggingface|deepseek|openrouter|vercel|cerebras|system-one|crusoe|elevenlabs|xai|"
    r"moonshotai|meta|fireworks|together|heroku|github|github-copilot|vllm|nebius|ovhcloud|"
    r"alibaba|sambanova|sentence-transformers|snowflake|typesafe|voyageai|zai|test|function):",
    re.IGNORECASE,
)


def _forbidden(name: str) -> bool:
    return any(name == module or name.startswith(module + ".") for module in _MODULES)


def lint_source(source: str) -> None:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        raise ValueError(_MESSAGE) from None
    dspy_modules = {"dspy"}
    dspy_constructors: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            dspy_modules.update(alias.asname or alias.name for alias in node.names if alias.name == "dspy")
        if isinstance(node, ast.ImportFrom) and node.module == "dspy":
            dspy_constructors.update(alias.asname or alias.name for alias in node.names if alias.name in {"LM", "Embedder"})
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(_forbidden(alias.name) for alias in node.names):
            raise ValueError(_MESSAGE)
        if isinstance(node, ast.ImportFrom) and node.module:
            if _forbidden(node.module) or any(_forbidden(node.module + "." + alias.name) for alias in node.names):
                raise ValueError(_MESSAGE)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and _PROVIDER.match(node.value):
            raise ValueError(_MESSAGE)
        if isinstance(node, ast.Call):
            dspy_constructor = (
                isinstance(node.func, ast.Name) and node.func.id in dspy_constructors
            ) or (
                isinstance(node.func, ast.Attribute) and node.func.attr in {"LM", "Embedder"}
                and isinstance(node.func.value, ast.Name) and node.func.value.id in dspy_modules
            )
            if dspy_constructor:
                model = next((keyword.value for keyword in node.keywords if keyword.arg == "model"), node.args[0] if node.args else None)
                if isinstance(model, ast.Constant) and isinstance(model.value, str):
                    raise ValueError(_MESSAGE)
            if (
                isinstance(node.func, ast.Name) and node.func.id == "infer_model"
            ) or (
                isinstance(node.func, ast.Attribute) and node.func.attr == "infer_model"
            ):
                raise ValueError(_MESSAGE)
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
