// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Script } from '../../../examples/rag-browser/test/support/adk-go-ref/run.js';

export type {
  Observed,
  Script,
  ScriptedReply,
} from '../../../examples/rag-browser/test/support/adk-go-ref/run.js';
export {
  buildReference,
  disposeReference,
  type NodeHost,
  type Reference,
  startNodeHost,
} from '../../../examples/rag-browser/test/support/adk-go-reference.node.js';
export {
  goAvailable,
  maxColdStartMs,
  maxWasmBytes,
  missingGo,
} from '../../../examples/rag-browser/test/support/go-gate.node.js';

export interface Golden {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly output: string;
  readonly error: { readonly code: string } | null;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function readScripts(): Promise<Record<string, Script>> {
  return JSON.parse(
    await readFile(join(root, 'tests/conformance/cases-adk-go/scripts.json'), 'utf8'),
  ) as Record<string, Script>;
}
export async function readGolden(name: string): Promise<Golden> {
  return JSON.parse(
    await readFile(join(root, `tests/conformance/golden-adk-go/${name}.json`), 'utf8'),
  ) as Golden;
}
