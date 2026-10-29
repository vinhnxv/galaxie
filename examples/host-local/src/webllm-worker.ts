// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Construction alone stays inert. Buffer messages until the engine handler is ready.
const messages: MessageEvent[] = [];
const first = Promise.withResolvers<void>();
const buffer = (event: MessageEvent): void => {
  messages.push(event);
  first.resolve();
};
self.addEventListener('message', buffer);
await first.promise;
const { startWebLLMWorker } = await import('@galaxie/models/webllm/worker');
self.removeEventListener('message', buffer);
startWebLLMWorker();
for (const event of messages) self.dispatchEvent(event);
