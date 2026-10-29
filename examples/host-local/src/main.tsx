// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './zod-config.js';
import { createRoot } from 'react-dom/client';

export async function createWebLLMWorker(): Promise<Worker> {
  const runtime = await import('./runtime.js');
  return runtime.createWebLLMWorker();
}

const root = document.getElementById('root');
if (root) {
  const { App } = await import('./app.js');
  const { createLocalHost } = await import('./runtime.js');
  const view = createRoot(root);
  if (import.meta.env.MODE === 'mock') {
    const { createMockModels } = await import('./mock-script.js');
    view.render(<App initialHost={createLocalHost(createMockModels())} />);
  } else {
    const { prepareLocalModels, realModels } = await import('./runtime.js');
    view.render(
      <App
        prepareModels={async () => {
          const handle = await prepareLocalModels();
          const host = createLocalHost(realModels(handle));
          window.addEventListener('pagehide', (event) => {
            if (!event.persisted) void host.runtime.dispose().finally(() => handle.dispose());
          });
          return host;
        }}
      />,
    );
  }
}
