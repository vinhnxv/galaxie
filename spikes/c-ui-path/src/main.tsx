// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
