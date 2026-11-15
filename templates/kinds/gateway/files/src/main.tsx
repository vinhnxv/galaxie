// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { createHybridHost } from './runtime.js';

const root = document.getElementById('root');
if (root === null) throw new Error('The application root is missing.');
const host = createHybridHost();
createRoot(root).render(<App host={host} />);
addEventListener(
  'pagehide',
  () => {
    void host.dispose();
  },
  { once: true },
);
