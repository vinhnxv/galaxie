// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { connection } from 'next/server';
import type { ReactElement } from 'react';

// Render per request so the nonce the proxy sets reaches Next's inline scripts; a statically
// prerendered 404 page would carry none and the policy would block them.
export default async function NotFound(): Promise<ReactElement> {
  await connection();
  return (
    <main>
      <h1>Page not found</h1>
      <a href="/">Back to the examples</a>
    </main>
  );
}
