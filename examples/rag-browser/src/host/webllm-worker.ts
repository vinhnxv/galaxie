// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
for (const event of messages.splice(0)) self.dispatchEvent(event);
