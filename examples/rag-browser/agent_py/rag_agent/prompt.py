# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import json
from pathlib import Path
from typing import Any

_path = Path(__file__).with_name("prompt.json")
if not _path.exists():
    _path = Path(__file__).resolve().parents[2] / "src/agent/prompt.json"
_prompt = json.loads(_path.read_text(encoding="utf-8"))
system_prompt = _prompt["system"]


def user_prompt(question: str, passages: list[dict[str, Any]]) -> str:
    references = [
        {"marker": index + 1, "id": passage["id"], "title": passage["title"], "text": passage["text"]}
        for index, passage in enumerate(passages)
    ]
    block = json.dumps(references, separators=(",", ":"), ensure_ascii=False)
    return (
        _prompt["questionPrefix"] + question + _prompt["referenceStart"] + block
        + _prompt["referenceEnd"] + (_prompt["usePassages"] if passages else _prompt["empty"])
    )
