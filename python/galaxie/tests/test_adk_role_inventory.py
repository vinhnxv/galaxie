# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.code_executors import BuiltInCodeExecutor
from google.adk.models import registry
from google.adk.models.base_llm import BaseLlm
from google.adk.models.google_llm import Gemini
from google.adk.planners import PlanReActPlanner
from google.adk.tools import google_search
from google.adk.utils.model_name_utils import is_gemini_model

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, llm
from galaxie.lint import lint_source


class ForeignModel(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        raise AssertionError('A foreign model must never run.')
        yield


@pytest.fixture(autouse=True)
def inventory(monkeypatch):
    monkeypatch.setattr(face, '_roles', frozenset({'answer', 'x', 'gemini-2.5-flash'}))


def unsupported(call):
    with pytest.raises(GalaxieError) as error:
        call()
    assert error.value.code == 'unsupported'
    assert str(error.value) == 'This operation is unsupported.'


def test_declared_string_maps_to_the_routed_model_without_registry_resolution(monkeypatch):
    monkeypatch.setattr(face, '_roles', frozenset({'answer'}), raising=False)
    agent = LlmAgent(name='root', model='answer')
    executor = Executor(agent)
    assert agent.model == llm('answer')
    seen = []

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'done'}})

    _bridge.install_transport(transport)
    assert asyncio.run(executor.run({'prompt': 'question'}, 's', 5)) == 'done'
    assert [message['op'] for message in seen] == ['model']
    assert seen[0]['payload']['role'] == 'answer'


def test_an_unknown_sibling_refuses_without_mutating_a_declared_string(monkeypatch):
    monkeypatch.setattr(face, '_roles', frozenset({'answer'}), raising=False)
    left = LlmAgent(name='left', model='answer')
    right = LlmAgent(name='right', model='unknown')
    root = SequentialAgent(name='root', sub_agents=[left, right])
    with pytest.raises(GalaxieError) as error:
        Executor(root)
    assert error.value.code == 'unsupported'
    assert left.model == 'answer'
    assert right.model == 'unknown'


@pytest.mark.parametrize('value', [
    'unknown', 'Answer', ' answer', 'answer ', '', 'galaxie/answer', 'galaxie:answer',
    1, {}, [], Gemini(model='gemini-2.5-flash'), ForeignModel(model='foreign'),
])
def test_unlisted_and_foreign_values_refuse_without_requests_or_changes(value):
    root = LlmAgent(name='root', model='answer')
    vars(root)['model'] = value
    seen = []

    async def transport(raw):
        seen.append(raw)
        raise AssertionError('Prepare must not dispatch.')

    _bridge.install_transport(transport)
    unsupported(lambda: Executor(root))
    assert root.model is value
    assert seen == []


def test_no_declared_roles_keeps_strings_refused(monkeypatch):
    monkeypatch.setattr(face, '_roles', frozenset())
    root = LlmAgent(name='root', model='answer')
    unsupported(lambda: Executor(root))
    assert root.model == 'answer'


def test_exact_agent_class_is_checked_before_mapping():
    class Foreign(LlmAgent):
        pass

    root = Foreign(name='root', model='answer')
    unsupported(lambda: Executor(root))
    assert root.model == 'answer'


def test_root_child_mixed_and_inherited_models_follow_the_same_tree_rules():
    child = LlmAgent(name='child')
    explicit = LlmAgent(name='explicit', model=llm('answer'))
    mapped = LlmAgent(name='mapped', model='x')
    root = LlmAgent(name='root', model='answer', sub_agents=[child, explicit, mapped])
    assert Executor(root)
    assert child.model == ''
    assert child.canonical_model is root.model
    assert root.model == explicit.model == llm('answer')
    assert mapped.model == llm('x')


@pytest.mark.parametrize('value', [None, 'answer', {}, [1], [''], ['x' * 129], ['x'] * 257])
def test_malformed_role_declarations_are_invalid(value):
    with pytest.raises(GalaxieError) as error:
        face._declare_roles(value)
    assert error.value.code == 'invalid'


def test_duplicate_roles_are_unsupported_and_a_valid_inventory_is_exact():
    unsupported(lambda: face._declare_roles(['answer', 'answer']))
    face._declare_roles(['answer', 'x'])
    assert face._roles == frozenset({'answer', 'x'})


@pytest.mark.parametrize('role', ['answer', 'gemini-2.5-flash', 'x'])
def test_string_guard_agrees_with_the_native_gemini_predicate(role):
    root = LlmAgent(name='root', model=role)
    if is_gemini_model(f'galaxie/{role}'):
        unsupported(lambda: Executor(root))
        assert root.model == role
    else:
        assert Executor(root)
        assert root.model == llm(role)
    assert Executor(LlmAgent(name='helper', model=llm(role)))


def test_prepare_and_run_never_construct_the_registered_decoy(monkeypatch):
    saved = dict(registry._llm_registry_dict)
    constructions = []

    class Decoy(BaseLlm):
        @classmethod
        def supported_models(cls):
            return ['^answer$']

        def __init__(self, **options):
            constructions.append(options)
            super().__init__(**options)

        async def generate_content_async(self, llm_request, stream=False):
            raise AssertionError('The native registry must not be used.')
            yield

    registry.LLMRegistry.register(Decoy)
    before = dict(registry._llm_registry_dict)
    cache = registry.LLMRegistry.resolve.cache_info()

    def refuse(*args, **kwargs):
        raise AssertionError('Registry resolution must not run.')

    monkeypatch.setattr(registry.LLMRegistry, 'new_llm', refuse)
    try:
        async def transport(raw):
            message = json.loads(raw)
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'done'}})

        _bridge.install_transport(transport)
        executor = Executor(LlmAgent(name='root', model='answer'))
        assert asyncio.run(executor.run({'prompt': 'question'}, 's', 5)) == 'done'
        assert constructions == []
        assert registry._llm_registry_dict == before
        assert registry.LLMRegistry.resolve.cache_info() == cache
    finally:
        registry._llm_registry_dict.clear()
        registry._llm_registry_dict.update(saved)
        registry.LLMRegistry.resolve.cache_clear()


@pytest.mark.parametrize('options', [
    {'tools': [google_search]}, {'code_executor': BuiltInCodeExecutor()}, {'planner': PlanReActPlanner()},
])
def test_a_declared_string_does_not_admit_builtin_tools_executors_or_planners(options):
    root = LlmAgent(name='root', model='answer', **options)
    unsupported(lambda: Executor(root))
    assert root.model == 'answer'


@pytest.mark.parametrize('silent', [False, True])
def test_assignment_failure_on_a_second_agent_restores_the_first(monkeypatch, silent):
    first = LlmAgent(name='first', model='answer')
    second = LlmAgent(name='second', model='answer')
    root = SequentialAgent(name='root', sub_agents=[first, second])
    before = [dict(agent.__dict__) for agent in (first, second)]

    def assign(agent, name, value):
        if agent is second:
            if silent:
                return
            raise ValueError('The second assignment is refused.')
        agent.__dict__[name] = value

    monkeypatch.setitem(LlmAgent.__pydantic_setattr_handlers__, 'model', assign)
    unsupported(lambda: Executor(root))
    assert [agent.__dict__ for agent in (first, second)] == before


def test_a_frozen_agent_and_a_missing_interaction_refuse_before_assignment():
    frozen = LlmAgent(name='frozen', model='answer')
    object.__setattr__(frozen, 'model_config', {**frozen.model_config, 'frozen': True})
    unsupported(lambda: Executor(frozen))
    assert frozen.model == 'answer'
    tool = face.capability_tool('double', 'math.double@1', {'type': 'object'}, 'Double.', require_confirmation=True)
    root = LlmAgent(name='root', model='answer', tools=[tool])
    unsupported(lambda: Executor(root))
    assert root.model == 'answer'


def test_assignment_rollback_preserves_the_authors_existing_resolution_cache(monkeypatch):
    first = LlmAgent(name='first', model='answer')
    second = LlmAgent(name='second', model='answer')
    cached = ('answer', ForeignModel(model='cached'))
    first._resolved_model = cached
    root = SequentialAgent(name='root', sub_agents=[first, second])
    fields = first.model_fields_set.copy()

    def assign(agent, name, value):
        if agent is second:
            raise ValueError('The second assignment is refused.')
        vars(agent)[name] = value

    monkeypatch.setitem(LlmAgent.__pydantic_setattr_handlers__, 'model', assign)
    unsupported(lambda: Executor(root))
    assert first.model == 'answer'
    assert first._resolved_model is cached
    assert first.model_fields_set == fields


def test_the_lint_aid_accepts_role_strings_and_still_refuses_provider_imports():
    lint_source("from google.adk.agents import LlmAgent\nLlmAgent(name='root', model='answer')")
    with pytest.raises(ValueError):
        lint_source('from google.adk.models.google_llm import Gemini')
    with pytest.raises(ValueError):
        lint_source("from google.adk.agents import LlmAgent\nLlmAgent(name='root', model='google:gemini')")


@pytest.mark.parametrize('kind', ['plain', 'lying-role', 'lying-empty'])
@pytest.mark.parametrize('position', ['root', 'inherited', 'sibling'])
def test_assigned_string_subclasses_refuse_without_requests_or_tree_mutation(kind, position):
    class Role(str):
        pass

    class LyingRole(str):
        def __eq__(self, other):
            return other == ('answer' if kind == 'lying-role' else '')

        def __ne__(self, other):
            return False

        def __hash__(self):
            return hash('answer' if kind == 'lying-role' else '')

        def __format__(self, spec):
            return 'answer'

    value = Role('answer') if kind == 'plain' else LyingRole('gemini-2.5-flash')
    candidate = LlmAgent(name='candidate', model='answer')
    vars(candidate)['model'] = value
    sibling = LlmAgent(name='sibling', model='answer')
    if position == 'inherited':
        root = LlmAgent(name='root', model=llm('answer'), sub_agents=[candidate])
    elif position == 'sibling':
        root = SequentialAgent(name='root', sub_agents=[sibling, candidate])
    else:
        root = candidate
    seen = []

    async def transport(raw):
        seen.append(raw)
        raise AssertionError('Prepare must not dispatch.')

    _bridge.install_transport(transport)
    unsupported(lambda: Executor(root))
    assert candidate.model is value
    assert sibling.model == 'answer'
    assert seen == []


@pytest.mark.parametrize('kind', ['enum', 'subclass'])
def test_normal_construction_normalizes_role_constants_to_exact_strings(kind):
    from enum import StrEnum

    class NamedRole(StrEnum):
        ANSWER = 'answer'

    class Role(str):
        pass

    value = NamedRole.ANSWER if kind == 'enum' else Role('answer')
    root = LlmAgent(name='root', model=value)
    assert type(root.model) is str
    assert root.model == 'answer'
    assert Executor(root)
    assert root.model == llm('answer')
    assert type(getattr(root.model, 'role')) is str


@pytest.mark.parametrize('length', [128, 129])
def test_model_string_inventory_length_boundary(length):
    role = 'x' * length
    if length == 128:
        face._declare_roles([role])
    root = LlmAgent(name='root', model=role)
    seen = []

    async def transport(raw):
        seen.append(raw)
        raise AssertionError('Prepare must not dispatch.')

    _bridge.install_transport(transport)
    if length == 128:
        assert Executor(root)
        assert root.model == llm(role)
    else:
        unsupported(lambda: Executor(root))
        assert root.model == role
    assert seen == []


@pytest.mark.parametrize(('roles', 'code'), [
    (['answer', 'answer'], 'unsupported'),
    (['answer', 'x' * 129], 'invalid'),
])
def test_failed_role_declaration_preserves_the_previous_inventory(roles, code):
    before = face._roles
    with pytest.raises(GalaxieError) as error:
        face._declare_roles(roles)
    assert error.value.code == code
    assert face._roles == before == frozenset({'answer', 'x', 'gemini-2.5-flash'})
