// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export const mockReply = 'This is a fixed reply from the mock upstream.';

/** Called only after the gateway validates and projects the request. */
export function createMockUpstream(): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = (await request.json()) as { model: string; stream: boolean };
    const envelope = { id: 'mock-reply', created: 0, model: body.model };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (body.stream) {
      const frames = [
        {
          ...envelope,
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { role: 'assistant', content: mockReply }, finish_reason: null },
          ],
        },
        {
          ...envelope,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        { ...envelope, object: 'chat.completion.chunk', choices: [], usage },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return Response.json({
      ...envelope,
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: mockReply }, finish_reason: 'stop' },
      ],
      usage,
    });
  };
}
