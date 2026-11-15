// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from examples/rag-browser/test/support/adk-go-ref/run.ts and
// adk-go-reference.node.ts: built adapter/worker imports, one non-streaming case,
// an in-memory tracer provider, offline build probes and an independent golden check.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createGoAdapter, GO_EXECUTOR_ID, type GoWorkerPort } from '@galaxie-ai/adapter-go';
import { createRuntime, defineAgentDefinition } from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { z } from 'zod';
import { createProvider } from './provider.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const execute = promisify(execFile);
const offlineEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GOTOOLCHAIN: 'local',
  GOOS: 'js',
  GOARCH: 'wasm',
  CGO_ENABLED: '0',
  GOPROXY: 'off',
  GOSUMDB: 'off',
};

interface GoLock {
  toolchain: string;
  modules: Array<{ path: string; version: string }>;
}

interface Unmeasured {
  measurement: 'unmeasured';
  reason: string;
  probes: string[];
}

interface Ready {
  measurement: 'ready';
  version: string;
  probes: string[];
}

interface Measured {
  measurement: 'measured';
  spans: readonly ReadableSpan[];
  modelCalls: number;
  capabilityCalls: number;
  outputCorrect: true;
  goldenMatched: true;
  versions: Record<string, string>;
  probes: string[];
}

interface Reply {
  content?: string;
  toolCalls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

interface Script {
  entry: string;
  prompt: string;
  replies: Reply[];
  capabilities: Record<string, { result: { value: number } }>;
}

function sanitizedFailure(error: unknown, directory?: string): string {
  const failure = error as { code?: string | number; stderr?: string; message?: string };
  const message = (failure.stderr?.trim() || failure.message || String(error)).split('\n')[0];
  return `exit ${failure.code ?? 'unknown'}: ${message}`
    .replaceAll(root, '<repository>/')
    .replaceAll(directory ?? '\0', '<temporary>')
    .replace(/\/(?:Users|home|private|tmp|var|opt|usr|root|etc)\/[^\s:'"]+/g, '<local-path>');
}

async function readLock(): Promise<GoLock> {
  return JSON.parse(await readFile(join(root, 'go/wasm.lock'), 'utf8')) as GoLock;
}

export async function probeGoVersion(actualVersion?: string): Promise<Ready | Unmeasured> {
  const lock = await readLock();
  const probes: string[] = [];
  let version = actualVersion;
  if (version === undefined) {
    try {
      version = (
        await execute('go', ['env', 'GOVERSION'], {
          cwd: root,
          env: offlineEnvironment,
          timeout: 30_000,
        })
      ).stdout.trim();
      probes.push('go env GOVERSION: exit 0');
    } catch (error) {
      const reason = `go env GOVERSION: ${sanitizedFailure(error)}`;
      return { measurement: 'unmeasured', reason, probes: [reason] };
    }
  } else probes.push('go env GOVERSION: injected version');
  if (version !== lock.toolchain) {
    const reason = `Go toolchain ${version} does not match go/wasm.lock (${lock.toolchain}).`;
    return { measurement: 'unmeasured', reason, probes };
  }
  return { measurement: 'ready', version, probes };
}

class ScriptedChatModel extends BaseChatModel {
  served = 0;
  readonly #replies: readonly Reply[];

  constructor(replies: readonly Reply[]) {
    super({});
    this.#replies = replies;
  }

  override _llmType(): string {
    return 'galaxie-adk-go-scripted';
  }

  override bindTools(): ScriptedChatModel {
    return this;
  }

  override async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const reply = this.#replies[this.served++];
    assert.ok(reply, 'The Go scenario exhausted its scripted model replies');
    return {
      generations: [
        {
          text: reply.content ?? '',
          message: new AIMessage({
            content: reply.content ?? '',
            tool_calls: (reply.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.function.name,
              args: JSON.parse(call.function.arguments) as Record<string, unknown>,
            })),
          }),
        },
      ],
    };
  }
}

const definition = defineAgentDefinition({
  id: 'conformance/adk-go',
  version: '1.0.0',
  executor: GO_EXECUTOR_ID,
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'read',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

export async function runGo(): Promise<Measured | Unmeasured> {
  const probe = await probeGoVersion();
  if (probe.measurement === 'unmeasured') return probe;
  const probes = [...probe.probes];
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-coverage-go-'));
  const file = join(directory, 'reference.wasm');
  try {
    for (const [label, args] of [
      ['node scripts/fetch-go-glue.ts', ['scripts/fetch-go-glue.ts']],
      [
        'node scripts/build-go-wasm.ts ./conformance/reference <temporary>/reference.wasm',
        ['scripts/build-go-wasm.ts', './conformance/reference', file],
      ],
    ] as const) {
      try {
        await execute(process.execPath, [...args], {
          cwd: root,
          env: offlineEnvironment,
          timeout: 300_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        probes.push(`${label}: exit 0`);
      } catch (error) {
        const reason = `${label}: ${sanitizedFailure(error, directory)}`;
        return { measurement: 'unmeasured', reason, probes: [...probes, reason] };
      }
    }
    const workerEntry = new URL('./worker.js', import.meta.resolve('@galaxie-ai/adapter-go'));
    const glue = pathToFileURL(join(root, '.cache/go-wasm/wasm_exec.js'));
    const bootstrap = join(directory, 'bootstrap.mjs');
    await writeFile(
      bootstrap,
      `// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
import { parentPort, workerData } from 'node:worker_threads';
globalThis.location = new URL(workerData.origin);
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, workerData.origin);
  if (url.origin !== new URL(workerData.origin).origin) throw new Error('External fetch refused by the Go coverage fixture');
  return originalFetch(input, init);
};
await import(${JSON.stringify(glue.href)});
await import(${JSON.stringify(workerEntry.href)});
`,
    );
    const wasmBytes = await readFile(file);
    const server = createServer((request, response) => {
      if (request.url !== '/reference.wasm') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/wasm' }).end(wasmBytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const workers: Worker[] = [];
    const host = createProvider({ live: false });
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string', 'The Go asset server has no port');
      const origin = `http://127.0.0.1:${address.port}/`;
      const frames: Array<{ op: string; payload: unknown }> = [];
      const scripts = JSON.parse(
        await readFile(join(root, 'tests/conformance/cases-adk-go/scripts.json'), 'utf8'),
      ) as Record<string, Script>;
      const script = scripts['capability-tool'];
      assert.ok(script, 'The capability-tool Go script is missing');
      const model = new ScriptedChatModel(script.replies);
      let capabilityCalls = 0;
      runtime = createRuntime({
        appId: 'adk-go-capability-tool',
        tracerProvider: host.provider,
        executors: [
          createGoAdapter({
            createWorker: (): GoWorkerPort => {
              const worker = new Worker(bootstrap, { workerData: { origin } });
              workers.push(worker);
              worker.on('message', (data: unknown) => {
                if (typeof data !== 'string') return;
                const message = JSON.parse(data) as {
                  kind: string;
                  op?: string;
                  payload?: string;
                };
                if (message.kind === 'call' && message.op && message.payload)
                  frames.push({ op: message.op, payload: JSON.parse(message.payload) });
              });
              const listeners = new Map<
                (event: { readonly data: unknown }) => void,
                (data: unknown) => void
              >();
              return {
                postMessage: (message) => worker.postMessage(message),
                addEventListener: ((type: 'message' | 'error', listener: never): void => {
                  if (type === 'message') {
                    const wrapped = (data: unknown): void =>
                      (listener as (event: { readonly data: unknown }) => void)({ data });
                    listeners.set(listener, wrapped);
                    worker.on('message', wrapped);
                  } else worker.on('error', listener);
                }) as GoWorkerPort['addEventListener'],
                removeEventListener: ((type: 'message' | 'error', listener: never): void => {
                  if (type === 'message') {
                    const wrapped = listeners.get(listener);
                    if (wrapped) worker.off('message', wrapped);
                    listeners.delete(listener);
                  } else worker.off('error', listener);
                }) as GoWorkerPort['removeEventListener'],
                terminate: () => void worker.terminate(),
              };
            },
          }),
        ],
        outputSafety: () => 'allow',
      });
      const instance = await runtime.create(definition, {
        principalScope: 'fixture',
        agent: {
          wasm: {
            url: `${origin}reference.wasm`,
            bytes: wasmBytes.byteLength,
            sha256: createHash('sha256').update(wasmBytes).digest('hex'),
          },
          entry: script.entry,
        },
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['tool-calling'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: async () => {
              capabilityCalls++;
              const outcome = script.capabilities['math.double@1'];
              assert.ok(outcome, 'The Go script must supply the capability result');
              return outcome.result;
            },
          },
        },
      });
      await instance.prepare();
      const { runId } = await instance.start({ prompt: script.prompt });
      let output: unknown;
      let runError: { code: string } | null = null;
      for await (const event of instance.events(runId)) {
        if (event.type === 'output') output = event.output;
        if (event.type === 'error') runError = { code: event.error.code };
      }
      const transcript = {
        requests: frames.filter((frame) => frame.op === 'model').map((frame) => frame.payload),
        responses: script.replies.slice(0, model.served),
        capabilities: frames
          .filter((frame) => frame.op === 'capability')
          .map((frame) => frame.payload),
        output,
        error: runError,
      };
      const golden = JSON.parse(
        await readFile(join(root, 'tests/conformance/golden-adk-go/capability-tool.json'), 'utf8'),
      ) as unknown;
      assert.deepEqual(
        transcript,
        golden,
        'Go wire transcript differs from the independent golden',
      );
      assert.equal(model.served, 2, 'The Go scenario must serve two scripted model calls');
      assert.equal(capabilityCalls, 1, 'The Go scenario must invoke one capability');
      assert.equal(instance.getSnapshot().run?.status, 'succeeded');
      assert.equal(output, 'The result is 42.');
      await runtime.dispose();
      await host.flush();
      const spans = [...host.oracle.getFinishedSpans()];
      const roots = spans.filter(
        (span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent',
      );
      const capabilities = spans.filter(
        (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
      );
      assert.equal(roots.length, 1, 'Go root span positive control');
      assert.equal(roots[0]?.attributes['galaxie.executor.id'], GO_EXECUTOR_ID);
      assert.equal(capabilities.length, 1, 'Go capability span positive control');
      const lock = await readLock();
      const adk = lock.modules.find((module) => module.path === 'google.golang.org/adk');
      assert.ok(adk, 'The Go lock must record the ADK version');
      return {
        measurement: 'measured',
        spans,
        modelCalls: model.served,
        capabilityCalls,
        outputCorrect: true,
        goldenMatched: true,
        versions: { go: lock.toolchain, adk: adk.version },
        probes,
      };
    } finally {
      await runtime?.dispose();
      await host.shutdown();
      await Promise.all(workers.map((worker) => worker.terminate()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
