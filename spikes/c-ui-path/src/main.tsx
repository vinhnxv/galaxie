// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime } from '@galaxie/core';
import { createRoot } from 'react-dom/client';

createRuntime({ appId: 'spike-c', executors: [createLangGraphAdapter()] });
const result = await fetch('/__single-copy').then((response) => response.json());
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <main>
      <h1>Spike C: UI path</h1>
      <p>Single copy: {String(result.ok)}</p>
    </main>,
  );
