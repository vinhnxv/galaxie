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
  return visit(value);
}

export async function writeEvidence(name: string, observations: Observation[]): Promise<void> {
  observations.sort(
    (a, b) =>
      a.probe.localeCompare(b.probe, 'en', { numeric: true }) || a.mode.localeCompare(b.mode),
  );
  const folder = new URL('../results/', import.meta.url);
  await mkdir(folder, { recursive: true });
  const evidence = {
    environment: { node: process.version, langgraph: '1.5.1', checkpoint: '1.2.0', scripted: true },
    ...(name === 'core' ? { C: observations } : { probes: observations }),
  };
  await writeFile(new URL(`${name}.json`, folder), `${JSON.stringify(evidence, null, 2)}\n`);
}
