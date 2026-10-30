// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import '../host/zod-config.js';

const pending: MessageEvent<unknown>[] = [];
const buffer = (event: MessageEvent<unknown>): void => {
  pending.push(event);
};
self.addEventListener('message', buffer);
const { RetrievalService } = await import('./service.js');

const scope = self as unknown as {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};
const service = new RetrievalService((event) => scope.postMessage(event));
let queue: Promise<void> = Promise.resolve();
const receive = (event: MessageEvent<unknown>): void => {
  queue = queue.then(() => service.handle(event.data));
};
self.removeEventListener('message', buffer);
scope.addEventListener('message', receive);
for (const event of pending.splice(0)) receive(event);
