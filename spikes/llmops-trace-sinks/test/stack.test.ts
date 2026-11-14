// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { normalize } from '../src/normalize.js';
import { readBack, waitForReadback } from '../src/readback.js';
import { makeSmoke, postSmoke } from '../src/smoke.js';

if (process.env['LLMOPS_STACK'] !== '1')
  console.info('Live stack checks skipped; set LLMOPS_STACK=1 or run pnpm run smoke.');

test.skipIf(process.env['LLMOPS_STACK'] !== '1')(
  'collector fans two spans out to both local backends',
  async () => {
    const smoke = makeSmoke();
    await postSmoke(smoke);
    await waitForReadback(smoke.traceId);
    await setTimeout(2000);
    const result = await readBack(smoke.traceId);
    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((item) => item.id))).toEqual(
      new Set([smoke.rootId, smoke.childId]),
    );
    for (const observation of result.observations) {
      expect(observation.traceId).toBe(smoke.traceId);
      expect(observation.metadata).toMatchObject({
        'attributes.smoke.string': 'local-only',
        'attributes.smoke.number': 7,
        'attributes.smoke.boolean': true,
      });
      if (observation.id === smoke.rootId) {
        expect(observation.sessionId).toBe(smoke.sessionId);
        expect(observation.parentObservationId).toBeNull();
        expect(observation.metadata).toMatchObject({
          'attributes.session.id': smoke.sessionId,
          'attributes.galaxie.session.id': smoke.sessionId,
          'attributes.galaxie.run.id': smoke.runId,
          'galaxie.run.id': smoke.runId,
        });
      } else {
        expect(observation.parentObservationId).toBe(smoke.rootId);
        expect(observation.sessionId).toBeFalsy();
        expect(observation.metadata).not.toHaveProperty('attributes.session.id');
        expect(observation.metadata).not.toHaveProperty('galaxie.run.id');
      }
    }
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.trace_id).toBe(`tr-${smoke.traceId}`);
    expect(result.spans).toHaveLength(2);
    expect(
      new Set(result.spans.map((span) => Buffer.from(span.span_id, 'base64').toString('hex'))),
    ).toEqual(new Set([smoke.rootId, smoke.childId]));
    for (const span of result.spans) {
      expect(Buffer.from(span.trace_id, 'base64').toString('hex')).toBe(smoke.traceId);
      const attributes = Object.fromEntries(
        span.attributes.map(({ key, value }) => [
          key,
          value.string_value ?? value.int_value ?? value.bool_value,
        ]),
      );
      expect(attributes).toMatchObject({
        'smoke.string': 'local-only',
        'smoke.number': 7,
        'smoke.boolean': true,
      });
      if (span.name === 'smoke-root') {
        expect(attributes).toMatchObject({
          'galaxie.session.id': smoke.sessionId,
          'session.id': smoke.sessionId,
          'galaxie.run.id': smoke.runId,
          'langfuse.observation.metadata.galaxie.run.id': smoke.runId,
        });
      } else {
        expect(Buffer.from(span.parent_span_id ?? '', 'base64').toString('hex')).toBe(smoke.rootId);
        expect(attributes).not.toHaveProperty('session.id');
        expect(attributes).not.toHaveProperty('langfuse.observation.metadata.galaxie.run.id');
      }
    }
    const services = execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        'galaxie-llmops-trace-sinks',
        '--file',
        fileURLToPath(new URL('../compose.yaml', import.meta.url)),
        '--env-file',
        fileURLToPath(new URL('../.env', import.meta.url)),
        'ps',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            Service: string;
            State: string;
            Health: string;
            Publishers: { URL: string; PublishedPort: number }[];
          },
      );
    expect(services).toHaveLength(8);
    const bindings = services.flatMap((service) => {
      expect(service.State).toBe('running');
      if (service.Service !== 'collector') expect(service.Health).toBe('healthy');
      return service.Publishers.filter((port) => port.PublishedPort > 0).map((port) => ({
        service: service.Service,
        address: port.URL,
        port: port.PublishedPort,
      }));
    });
    expect(bindings).toHaveLength(3);
    expect(bindings.every((binding) => binding.address === '127.0.0.1')).toBe(true);
    const listeners = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).split('\n');
    const ports = bindings.map((binding) => binding.port);
    const selected = listeners.filter((line) =>
      ports.some((port) => new RegExp(`:${port} \\(LISTEN\\)`).test(line)),
    );
    expect(selected).toHaveLength(3);
    expect(selected.every((line) => /TCP 127\.0\.0\.1:\d+ \(LISTEN\)/.test(line))).toBe(true);
    const folder = new URL('../results/', import.meta.url);
    mkdirSync(folder, { recursive: true });
    result.observations.sort((a, b) => a.name.localeCompare(b.name));
    result.spans.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(
      new URL('smoke.json', folder),
      `${JSON.stringify({ demonstration: true, readback: normalize(result, smoke), ports: { bindings, hostListeners: selected.map((line) => line.slice(line.indexOf('TCP '))), command: 'lsof -nP -iTCP -sTCP:LISTEN', wildcardListeners: false }, scope: 'One two-span hand-made trace, checked again after two seconds. No galaxie runtime runs.' }, null, 2)}\n`,
    );
  },
);
