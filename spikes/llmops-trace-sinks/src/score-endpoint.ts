// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Observation } from './readback.js';
import type { ScoreOutcome } from './scores.js';

export interface ScoreReport {
  runId: string;
  segment: number;
  traceId: string;
  name: 'feedback';
  value: number;
}

export interface ScoreEndpoint {
  issueSession(user: string): string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

function validReport(value: unknown): value is ScoreReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).sort().join(',') === 'name,runId,segment,traceId,value' &&
    typeof body['runId'] === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(body['runId']) &&
    typeof body['traceId'] === 'string' &&
    /^[a-f0-9]{32}$/.test(body['traceId']) &&
    typeof body['segment'] === 'number' &&
    Number.isSafeInteger(body['segment']) &&
    body['segment'] >= 0 &&
    body['name'] === 'feedback' &&
    typeof body['value'] === 'number' &&
    Number.isFinite(body['value']) &&
    body['value'] >= 0 &&
    body['value'] <= 1
  );
}

export function createScoreEndpoint(options: {
  observations(query: Record<string, string>): Promise<Observation[]>;
  scoreClient: {
    post(entry: { traceId: string }, name: string, value: number): Promise<ScoreOutcome>;
  };
}): ScoreEndpoint {
  const sessions = new Map<string, string>();
  const runOwners = new Map<string, string>();
  const runs = new Map<string, Map<number, string>>();
  const traces = new Map<string, { user: string; runId: string; segment: number }>();
  return {
    issueSession(user) {
      const token = randomBytes(32).toString('hex');
      sessions.set(token, user);
      return `llmops-session=${token}; HttpOnly; SameSite=Strict; Path=/`;
    },
    async handle(request, response) {
      const reply = (status: number, reason: string): void => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ reason }));
      };
      const token = request.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('llmops-session='))
        ?.slice('llmops-session='.length);
      const user = token === undefined ? undefined : sessions.get(token);
      if (user === undefined) {
        reply(401, 'unauthenticated');
        return;
      }
      let body: unknown;
      try {
        if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
          reply(400, 'invalid');
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > 4096) {
            reply(400, 'invalid');
            return;
          }
          chunks.push(bytes);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(400, 'invalid');
        return;
      }
      if (!validReport(body)) {
        reply(400, 'invalid');
        return;
      }
      try {
        const observations = await options.observations({
          traceId: body.traceId,
          filter: JSON.stringify([
            {
              type: 'stringObject',
              column: 'metadata',
              key: 'galaxie.run.id',
              operator: '=',
              value: body.runId,
            },
          ]),
        });
        if (
          !observations.some(
            (observation) =>
              observation.traceId === body.traceId &&
              !observation.parentObservationId &&
              observation.metadata['galaxie.run.id'] === body.runId &&
              observation.metadata['attributes.galaxie.run.segment'] === body.segment,
          )
        ) {
          reply(404, 'not-confirmed');
          return;
        }
        const owner = runOwners.get(body.runId);
        const boundTrace = traces.get(body.traceId);
        const boundSegment = runs.get(body.runId)?.get(body.segment);
        if (
          (owner !== undefined && owner !== user) ||
          (boundSegment !== undefined && boundSegment !== body.traceId) ||
          (boundTrace !== undefined &&
            (boundTrace.user !== user ||
              boundTrace.runId !== body.runId ||
              boundTrace.segment !== body.segment))
        ) {
          reply(403, 'forbidden');
          return;
        }
        // Commit the confirmed binding before the upstream post. A failed post leaves ownership
        // intact, so the same user can retry without another user taking the association.
        const segments = runs.get(body.runId) ?? new Map<number, string>();
        segments.set(body.segment, body.traceId);
        runs.set(body.runId, segments);
        runOwners.set(body.runId, user);
        traces.set(body.traceId, { user, runId: body.runId, segment: body.segment });
        const result = await options.scoreClient.post(
          { traceId: body.traceId },
          body.name,
          body.value,
        );
        const accepted = result.status === 'posted' || result.status === 'unchanged';
        reply(accepted ? 200 : 502, accepted ? result.status : 'upstream-error');
      } catch {
        reply(502, 'upstream-error');
      }
    },
  };
}
