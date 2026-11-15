// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { createTemplateHost } from './runtime.js';

const root = document.getElementById('root');
if (root === null) throw new Error('The application root is missing.');
const host = await createTemplateHost();
createRoot(root).render(<App host={host} />);
addEventListener(
  'pagehide',
  () => {
    void host.dispose();
  },
  { once: true },
);
