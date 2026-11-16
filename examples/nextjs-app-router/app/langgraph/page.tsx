// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { connection } from 'next/server';
import type { ReactElement } from 'react';
import { ClientAgent } from '../../src/client.js';

export default async function Page(): Promise<ReactElement> {
  await connection();
  return (
    <main>
      <h1>LangGraph.js browser agent</h1>
      <p>Memory-only mock example.</p>
      <ClientAgent framework="langgraph" />
    </main>
  );
}
