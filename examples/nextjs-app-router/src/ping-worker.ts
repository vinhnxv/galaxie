// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.data === 'ping') postMessage('pong');
});
