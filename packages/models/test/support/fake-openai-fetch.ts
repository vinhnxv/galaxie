// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export interface RecordedOpenAIRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface FakeOpenAIOptions {
  readonly status?: number;
  readonly text?: string;
  readonly usage?: boolean;
  readonly failure?: boolean;
  readonly malformed?: boolean;
  readonly finishReason?: string;
  readonly message?: Record<string, unknown>;
  readonly deltas?: readonly Record<string, unknown>[];
  readonly beforeChunk?: (index: number, signal: AbortSignal) => void | Promise<void>;
}

/** In-memory HTTP responses shared by Node and Chromium; never uses the network. */
export class FakeOpenAIFetch {
  readonly requests: RecordedOpenAIRequest[] = [];
  cancellations = 0;
  readonly #options: FakeOpenAIOptions;

  constructor(options: FakeOpenAIOptions = {}) {
    this.#options = options;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    this.requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      signal: request.signal,
    });
    const options = this.#options;
    if (options.failure) throw new TypeError('endpoint-body-marker');
    if (options.status !== undefined)
      return Response.json(
        { error: { message: 'endpoint-body-marker' } },
        { status: options.status },
      );
    if (options.malformed)
      return new Response('endpoint-body-marker', {
        headers: { 'content-type': 'application/json' },
      });
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    const finish_reason = options.finishReason ?? 'stop';
    const text = options.text ?? 'hello world';
    if (!body['stream'])
      return Response.json({
        id: 'fake-completion',
        object: 'chat.completion',
        created: 0,
        model: 'fake',
        choices: [
          {
            index: 0,
            finish_reason,
            message: { role: 'assistant', content: text, ...options.message },
          },
        ],
        ...(options.usage === false ? {} : { usage }),
      });
    const frames: unknown[] = (
      options.deltas ?? [{ role: 'assistant', content: 'hello ' }, { content: 'world' }]
    ).map((delta) => ({
      id: 'fake-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake',
      choices: [{ index: 0, delta, finish_reason: null }],
    }));
    frames.push({
      id: 'fake-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake',
      choices: [{ index: 0, delta: {}, finish_reason }],
    });
    const events: unknown[] = [...frames];
    if (options.usage !== false) events.push({ choices: [], usage });
    let index = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        await options.beforeChunk?.(index, request.signal);
        if (request.signal.aborted) {
          controller.error(request.signal.reason);
          return;
        }
        if (index < events.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        } else {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
      cancel: () => {
        this.cancellations++;
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
}
