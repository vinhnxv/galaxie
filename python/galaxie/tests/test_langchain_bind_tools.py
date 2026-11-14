# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import BaseModel

from galaxie.langchain import GalaxieChatModel
from test_langchain_tool_calls import SCHEMA, plain_tool, transport_for


class Arguments(BaseModel):
    value: int


def test_bind_tools_characterization():
    seen = transport_for(lambda _: pytest.fail('Unexpected bridge request.'))
    with pytest.raises(NotImplementedError) as error:
        GalaxieChatModel(role='answer').bind_tools([plain_tool])
    assert type(error.value) is NotImplementedError
    assert seen == []


@pytest.mark.parametrize('schema', [SCHEMA, Arguments])
def test_structured_output_characterization(schema):
    with pytest.raises(NotImplementedError) as error:
        GalaxieChatModel(role='answer').with_structured_output(schema)
    assert type(error.value) is NotImplementedError
