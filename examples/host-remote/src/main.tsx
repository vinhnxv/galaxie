// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './zod-config.js';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
