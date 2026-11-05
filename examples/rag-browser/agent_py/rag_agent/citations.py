# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import re
from typing import Any


def cite_answer(reply: str, passages: list[dict[str, Any]]) -> dict[str, Any]:
    citations = []
    seen = set()

    def replace(match: re.Match[str]) -> str:
        digits = match.group(1).lstrip("0") or "0"
        if len(digits) > 16:
            return ""
        marker = int(digits)
        if marker < 1 or marker > 9_007_199_254_740_991 or marker > len(passages):
            return ""
        passage = passages[marker - 1]
        if marker not in seen:
            seen.add(marker)
            citations.append({
                "marker": marker,
                "passageId": passage["id"],
                "title": passage["title"],
                "text": passage["text"],
            })
        return match.group(0)

    sources = [{"passageId": p["id"], "title": p["title"], "text": p["text"]} for p in passages]
    return {"answer": re.sub(r"\[([0-9]+)\]", replace, reply), "citations": citations, "sources": sources}
