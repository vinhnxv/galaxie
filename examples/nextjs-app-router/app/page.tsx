// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ReactElement } from 'react';

export default function Page(): ReactElement {
  return (
    <main>
      <h1>Next.js browser agents</h1>
      <a href="/langgraph">LangGraph.js</a>
      <a href="/adk">ADK JS</a>
    </main>
  );
}
