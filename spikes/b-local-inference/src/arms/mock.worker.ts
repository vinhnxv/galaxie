// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonSchema } from './types.js';
import { serveWorker } from './worker-rpc.js';

const failure = (self as unknown as DedicatedWorkerGlobalScope).name;
let leakedWord = '';
function fixture(schema: JsonSchema): unknown {
  if (schema['enum']) return (schema['enum'] as unknown[])[0];
  if (schema['anyOf']) return fixture((schema['anyOf'] as JsonSchema[])[0] ?? {});
  if (schema['type'] === 'object')
    return Object.fromEntries(
      Object.entries(schema['properties'] as Record<string, JsonSchema>).map(([key, value]) => [
        key,
        fixture(value),
      ]),
    );
  if (schema['type'] === 'array')
    return Array.from({ length: Number(schema['minItems'] ?? 1) }, () =>
      fixture(schema['items'] as JsonSchema),
    );
  if (schema['type'] === 'number') return 1;
  if (schema['type'] === 'boolean') return true;
  return 'Example';
}
serveWorker({
  async load() {
    return { loadKind: 'warm', reportedBytes: 0 };
  },
  async generate(request, history, signal, emit) {
    const remembered = [...history, ...request.messages]
      .map((message) => message.content)
      .join(' ')
      .match(/Remember the code word ([\w-]+)/)?.[1];
    if (remembered) leakedWord = remembered;
    let text: string;
    if (request.schema) {
      text =
        failure === 'schema' && 'code' in (request.schema['properties'] as object)
          ? 'A sentence about the weather.'
          : JSON.stringify(fixture(request.schema));
    } else if (request.messages.at(-1)?.content.includes('What code word')) {
      text = remembered ?? (failure === 'reset' ? leakedWord : 'unknown');
    } else {
      text = 'Use the past tense went. Yesterday describes a completed action.';
    }
    let emitted = '';
    for (let offset = 0; offset < text.length; offset += 8) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (signal.aborted && failure !== 'cancel') break;
      const chunk = text.slice(offset, offset + 8);
      emitted += chunk;
      emit(chunk);
    }
    return {
      text: emitted,
      constrained: Boolean(request.schema) && failure !== 'schema',
      aborted: signal.aborted && failure !== 'cancel',
    };
  },
  async dispose() {
    leakedWord = '';
  },
});
