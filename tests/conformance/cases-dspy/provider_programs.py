# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Test-only DSPy provider probes; all attempted egress is rejected locally."""

from contextlib import contextmanager, ExitStack
import importlib.util
import json
import os
import socket
import sys
from typing import Any, Literal
from unittest.mock import patch

import dspy
from dspy.dsp.utils import dotdict
from galaxie._bridge import notify_stream_data
from galaxie.dspy import Executor, GalaxieLM
from pydantic import BaseModel

MODEL = 'openai/gpt-4o'
EMBEDDING_MODEL = 'openai/text-embedding-3-small'
KEY = 'fixture-not-a-credential'
BASE = 'http://127.0.0.1:9'
REPLY = '[[ ## answer ## ]]\ndone\n[[ ## completed ## ]]'


@contextmanager
def egress_recorder():
    evidence = {'attempts': [], 'recorder': True, 'unexpected': False}
    with ExitStack() as stack:
        # No ambient credentials, gateways or proxies influence these probes.
        for key in list(os.environ):
            if key.startswith('OPENAI_') or key.lower().endswith('_proxy'):
                stack.enter_context(patch.dict(os.environ, {key: ''}))
        if sys.platform == 'emscripten':
            import js
            from pyodide.ffi import create_proxy

            def reject(input, *args):
                url = js.URL.new(input if isinstance(input, str) else input.url)
                target = f'{url.hostname}:{url.port or ("443" if url.protocol == "https:" else "80")}'
                if target == '127.0.0.1:9':
                    evidence['attempts'].append(target)
                else:
                    evidence['unexpected'] = True
                return js.Promise.reject(js.Error.new('Provider probe rejects egress.'))

            previous = js.globalThis.fetch
            proxy = create_proxy(reject)
            installed = False
            try:
                js.globalThis.fetch = proxy
                installed = True
            except Exception:
                evidence['recorder'] = False
            try:
                yield evidence
            finally:
                if installed:
                    js.globalThis.fetch = previous
                proxy.destroy()
        else:
            def reject(host, port):
                if (str(host), int(port)) == ('127.0.0.1', 9):
                    evidence['attempts'].append('127.0.0.1:9')
                else:
                    evidence['unexpected'] = True
                raise ConnectionRefusedError('Provider probe rejects egress.')

            def connect(_socket, address):
                return reject(*address[:2])

            def resolve(host, port, *args, **kwargs):
                return reject(host, port)

            stack.enter_context(patch.object(socket.socket, 'connect', connect))
            stack.enter_context(patch.object(socket.socket, 'connect_ex', connect))
            stack.enter_context(patch.object(socket, 'getaddrinfo', resolve))
            yield evidence


class LiteralAnswer(dspy.Signature):
    question: str = dspy.InputField()
    answer: Literal['done', 'other'] = dspy.OutputField()


class IntegerAnswer(dspy.Signature):
    question: str = dspy.InputField()
    answer: int = dspy.OutputField()


class AnswerModel(BaseModel):
    answer: str


def signature_for(kind):
    return LiteralAnswer if kind == 'literal' else 'question: str -> answer: str'


class LocalRM:
    def __call__(self, query, k):
        return [dotdict(long_text=value) for value in ['local a', 'local b'][:k]]


class Program(dspy.Module):
    def __init__(self, name):
        super().__init__()
        self.name = name
        signature = (LiteralAnswer if name == 'pe-schema-typed-ok' else
                     IntegerAnswer if name == 'pe-schema-typed-violation' else
                     signature_for('control'))
        config: dict[str, Any] = {'response_format': AnswerModel} if name == 'pe-schema-response-format' else {}
        self.predict = dspy.Predict(signature, **config)
        self.predict.set_lm(GalaxieLM('answer'))

    async def aforward(self, question):
        evidence = None
        try:
            with egress_recorder() as evidence:
                return await self.probe(question)
        finally:
            if evidence is not None:
                notify_stream_data([], 'updates', {'kind': 'provider-egress', **evidence})

    async def probe(self, question):
        name = self.name
        if name == 'pe-env-facts':
            facts = {key: importlib.util.find_spec(key) is not None
                     for key in ('litellm', 'openai', 'numpy', 'faiss', 'requests', 'httpx')}
            return dspy.Prediction(facts=json.dumps(facts, sort_keys=True))
        if name.startswith('pe-lm-runtime-'):
            config = {'api_base': BASE, 'cache': False, 'num_retries': 0}
            if name != 'pe-lm-runtime-nokey':
                config['api_key'] = KEY
            lm = dspy.LM(MODEL, **config)
            if name == 'pe-lm-runtime-context':
                # A bound predictor wins over settings.lm. Remove it after prepare.
                self.predict.lm = None
                with dspy.context(lm=lm):
                    return await self.predict.acall(question=question)
            self.predict.set_lm(lm)
            return await self.predict.acall(question=question)
        if name == 'pe-lm-kwargs':
            return await self.predict.acall(question=question, config={'temperature': 0.2})
        if name == 'pe-embed-hosted-string':
            provider_options: dict[str, Any] = {'api_key': KEY, 'api_base': BASE}
            await dspy.Embedder(EMBEDDING_MODEL, caching=False, **provider_options).acall(['a'])
        elif name in ('pe-embed-callable', 'pe-embed-retriever'):
            embedder = dspy.Embedder(lambda texts: [[0.0, 1.0] for _ in texts], caching=False)
            if name == 'pe-embed-callable':
                await embedder.acall(['a'])
            else:
                dspy.Embeddings(['a', 'b'], embedder=embedder, k=1)
        elif name.startswith('pe-retrieve-'):
            rm = LocalRM() if name == 'pe-retrieve-local-rm' else dspy.ColBERTv2(url='http://127.0.0.1', port=9)
            with dspy.context(rm=rm):
                return dspy.Retrieve(k=2 if name == 'pe-retrieve-local-rm' else 1)(question)
        else:
            return await self.predict.acall(question=question)
        return dspy.Prediction(answer='unexpected success')


def factory(name):
    if name == 'pe-schema-candidate-shape':
        raise ValueError('The schema-shape probe runs only in plain native DSPy.')
    return Executor(Program(name), adapter=dspy.ChatAdapter(use_json_adapter_fallback=False))
