// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './adk-env.js';
import './style.css';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (root) {
  const { App } = await import('./app.js');
  createRoot(root).render(<App />);
}
