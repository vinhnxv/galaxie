# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

from delegation import factory
from galaxie import _bridge


def test_smoke():
    seen = []

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['op'])
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'done'}})

    _bridge.install_transport(transport)
    assert asyncio.run(factory().run({'prompt': 'smoke'}, 'smoke', 5)) == 'done'
    assert seen == ['model']
