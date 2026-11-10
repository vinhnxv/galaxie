// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from '@galaxie-ai/core';

function isSet(value: unknown): boolean {
  return value != null && (!Array.isArray(value) || value.length > 0);
}

function inspect(graph: object): void {
  const source = graph as Record<string, unknown>;
  if (isSet(source['interruptBefore']) || isSet(source['interruptAfter'])) throw new Error();
  const config = source['config'];
  if (typeof config === 'object' && config !== null) {
    const settings = config as Record<string, unknown>;
    if (isSet(settings['interruptBefore']) || isSet(settings['interruptAfter'])) throw new Error();
  }
}

export async function refuseStaticBreakpoints(graph: object): Promise<void> {
  try {
    inspect(graph);
    const source = graph as Record<string, unknown>;
    const enumerate =
      typeof source['getSubgraphsAsync'] === 'function'
        ? source['getSubgraphsAsync']
        : source['getSubgraphs'];
    if (typeof enumerate !== 'function') return;
    const subgraphs = enumerate.call(graph, undefined, true) as
      | AsyncIterable<unknown>
      | Iterable<unknown>;
    for await (const entry of subgraphs) {
      if (!Array.isArray(entry) || typeof entry[1] !== 'object' || entry[1] === null)
        throw new Error();
      inspect(entry[1]);
    }
  } catch {
    throw new GalaxieError('unsupported', 'The graph must not use compiled static breakpoints.');
  }
}
