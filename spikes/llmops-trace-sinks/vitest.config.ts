// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { configDefaults, defineConfig } from 'vitest/config';
import { shared, singleCopy } from './src/single-copy.js';

export default defineConfig({
  resolve: { dedupe: shared },
  plugins: [singleCopy()],
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 400_000,
    exclude: [...configDefaults.exclude, 'python/**'],
  },
});
