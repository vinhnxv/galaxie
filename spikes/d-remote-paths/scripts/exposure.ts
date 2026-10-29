// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CDPSession } from 'playwright';

export interface SecretScanner {
  push: (text: string) => void;
  detected: () => boolean;
}

export function secretScanner(secret: string): SecretScanner {
  let tail = '';
  let detected = false;
  return {
    push: (text) => {
      detected ||= (tail + text).includes(secret);
      tail = detected ? '' : (tail + text).slice(-(secret.length - 1));
    },
    detected: () => detected,
  };
}

export async function watchResponses(
  session: CDPSession,
  makeScanner: () => SecretScanner,
): Promise<{
  settle: () => Promise<void>;
  detected: () => boolean;
}> {
  const captures = new Map<string, { scanner: SecretScanner; ready: boolean; pending: string[] }>();
  const inspections: Promise<void>[] = [];
  const finished = new Set<string>();
  const completions = new Map<string, () => void>();
  const waiting: Promise<void>[] = [];
  let failed = false;
  function finish(requestId: string): void {
    finished.add(requestId);
    completions.get(requestId)?.();
  }
  session.on('Network.loadingFinished', ({ requestId }) => finish(requestId));
  session.on('Network.loadingFailed', ({ requestId }) => finish(requestId));
  session.on('Network.dataReceived', ({ requestId, data }) => {
    if (!data) return;
    const capture = captures.get(requestId);
    if (!capture) return;
    const text = Buffer.from(data, 'base64').toString('utf8');
    if (capture.ready) capture.scanner.push(text);
    else capture.pending.push(text);
  });
  session.on('Network.responseReceived', ({ requestId, response, type }) => {
    const capture = { scanner: makeScanner(), ready: false, pending: [] as string[] };
    captures.set(requestId, capture);
    capture.scanner.push(JSON.stringify(response.headers));
    // Preflight bodies are not exposed to page code; 204/304 have no HTTP body.
    const empty =
      type === 'Preflight' ||
      response.status === 204 ||
      response.status === 304 ||
      Object.entries(response.headers).some(
        ([name, value]) => name.toLowerCase() === 'content-length' && value === '0',
      );
    waiting.push(
      new Promise<void>((resolve) => {
        if (finished.has(requestId)) resolve();
        else completions.set(requestId, resolve);
      }),
    );
    inspections.push(
      (async () => {
        if (empty) {
          capture.ready = true;
          return;
        }
        try {
          const { bufferedData } = await session.send('Network.streamResourceContent', {
            requestId,
          });
          capture.scanner.push(Buffer.from(bufferedData, 'base64').toString('utf8'));
          for (const text of capture.pending) capture.scanner.push(text);
          capture.pending.length = 0;
          capture.ready = true;
        } catch {
          // A completed/cache-served resource may no longer support streaming.
          // A failed body read is a coverage failure, including an aborted prefix.
          try {
            const { body, base64Encoded } = await session.send('Network.getResponseBody', {
              requestId,
            });
            capture.scanner.push(
              base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body,
            );
          } catch {
            failed = true;
          }
        }
      })(),
    );
  });
  await session.send('Network.enable');
  return {
    settle: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...inspections, ...waiting]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('response_inspection_incomplete')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (failed) throw new Error('response_inspection_incomplete');
    },
    detected: () => [...captures.values()].some((capture) => capture.scanner.detected()),
  };
}
