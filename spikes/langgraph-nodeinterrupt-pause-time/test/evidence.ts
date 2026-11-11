// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from 'node:fs/promises';
import type { Durability } from '../src/graphs.js';

export interface Observation {
  probe: string;
  mode: Durability;
  pass: boolean;
  observation: unknown;
}

export function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string')
      return item.replace(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32}/g,
        (id) => {
          if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
          return ids.get(id) as string;
        },
      );
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [visit(key), visit(child)]),
      );
    return item;
  };
  // Match the serialized transcript contract, including omission of undefined id keys.
  return visit(JSON.parse(JSON.stringify(value)));
}

export async function writeEvidence(observations: Observation[]): Promise<void> {
  observations.sort(
    (a, b) =>
      a.probe.localeCompare(b.probe, 'en', { numeric: true }) || a.mode.localeCompare(b.mode),
  );
  const folder = new URL('../results/', import.meta.url);
  await mkdir(folder, { recursive: true });
  await writeFile(
    new URL('native.json', folder),
    `${JSON.stringify(
      {
        environment: {
          node: process.version,
          langgraph: '1.5.1',
          core: '1.2.20',
          checkpoint: '1.2.0',
          scripted: true,
        },
        probes: observations,
      },
      null,
      2,
    )}\n`,
  );
}
